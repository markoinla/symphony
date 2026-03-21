defmodule SymphonyElixirWeb.Presenter do
  @moduledoc """
  Shared projections for the observability API and dashboard.
  """

  alias SymphonyElixir.{Config, Orchestrator, SessionLog, StatusDashboard, Store}

  @spec state_payload(GenServer.name() | [{String.t(), GenServer.name()}], timeout()) :: map()
  def state_payload(orchestrator, snapshot_timeout_ms) do
    generated_at = DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()

    case fetch_snapshots(orchestrator, snapshot_timeout_ms) do
      {:ok, [{nil, snapshot}]} ->
        single_state_payload(snapshot, generated_at)

      {:ok, snapshots} ->
        multi_state_payload(snapshots, generated_at)

      {:error, :timeout} ->
        %{generated_at: generated_at, error: %{code: "snapshot_timeout", message: "Snapshot timed out"}}

      {:error, :unavailable} ->
        %{generated_at: generated_at, error: %{code: "snapshot_unavailable", message: "Snapshot unavailable"}}
    end
  end

  @spec issue_payload(String.t(), GenServer.name() | [{String.t(), GenServer.name()}], timeout()) ::
          {:ok, map()} | {:error, :issue_not_found}
  def issue_payload(issue_identifier, orchestrator, snapshot_timeout_ms) when is_binary(issue_identifier) do
    case fetch_snapshots(orchestrator, snapshot_timeout_ms) do
      {:ok, snapshots} ->
        case find_issue_entries(snapshots, issue_identifier) do
          {nil, nil} -> {:error, :issue_not_found}
          {running, retry} -> {:ok, issue_payload_body(issue_identifier, running, retry)}
        end

      {:error, _reason} ->
        {:error, :issue_not_found}
    end
  end

  @spec messages_payload(String.t(), GenServer.name() | [{String.t(), GenServer.name()}], timeout()) ::
          {:ok, map()} | {:error, :issue_not_found | :session_log_not_found}
  def messages_payload(issue_identifier, orchestrator, snapshot_timeout_ms) do
    with {:ok, payload} <- issue_payload(issue_identifier, orchestrator, snapshot_timeout_ms),
         {:ok, issue_id, session_id} <- payload_message_context(payload),
         {:ok, msgs} <- SessionLog.get_messages(issue_id, session_id) do
      {:ok,
       %{
         issue_identifier: issue_identifier,
         session_id: session_id,
         messages: Enum.map(msgs, &message_payload/1)
       }}
    else
      {:error, :not_found} -> {:error, :session_log_not_found}
      {:error, reason} -> {:error, reason}
    end
  end

  defp message_payload(msg) do
    %{
      id: msg.id,
      timestamp: iso8601(msg.timestamp),
      type: to_string(msg.type),
      content: msg.content,
      metadata: msg.metadata
    }
  end

  defp payload_message_context(payload) when is_map(payload) do
    issue_id = payload[:issue_id]

    session_id =
      case payload[:running] do
        %{session_id: sid} when is_binary(sid) -> sid
        _ -> nil
      end

    if issue_id && session_id do
      {:ok, issue_id, session_id}
    else
      {:error, :session_log_not_found}
    end
  end

  @spec refresh_payload(GenServer.name() | [{String.t(), GenServer.name()}]) :: {:ok, map()} | {:error, :unavailable}
  def refresh_payload(orchestrator) do
    case request_refresh_results(orchestrator) do
      [] ->
        {:error, :unavailable}

      [{nil, payload}] ->
        {:ok, Map.update!(payload, :requested_at, &DateTime.to_iso8601/1)}

      payloads ->
        requested_at =
          payloads
          |> Enum.map(fn {_workflow_name, payload} -> payload.requested_at end)
          |> Enum.max_by(&DateTime.to_unix(&1, :microsecond))

        {:ok,
         %{
           queued: true,
           coalesced: Enum.all?(payloads, fn {_workflow_name, payload} -> payload.coalesced end),
           requested_at: DateTime.to_iso8601(requested_at),
           operations: ["poll", "reconcile"],
           workflows:
             Enum.map(payloads, fn {workflow_name, payload} ->
               payload
               |> Map.put(:workflow_name, workflow_name)
               |> Map.update!(:requested_at, &DateTime.to_iso8601/1)
             end)
         }}
    end
  end

  defp fetch_snapshots(orchestrator, snapshot_timeout_ms) do
    snapshots =
      orchestrator_sources(orchestrator)
      |> Enum.reduce([], fn {workflow_name, server}, acc ->
        case Orchestrator.snapshot(server, snapshot_timeout_ms) do
          %{} = snapshot -> [{workflow_name, snapshot} | acc]
          :timeout -> [{:timeout, workflow_name} | acc]
          :unavailable -> acc
        end
      end)
      |> Enum.reverse()

    ok_snapshots =
      Enum.filter(snapshots, fn
        {workflow_name, %{} = _snapshot} when is_binary(workflow_name) or is_nil(workflow_name) -> true
        _ -> false
      end)

    case ok_snapshots do
      [] ->
        if Enum.any?(snapshots, &match?({:timeout, _workflow_name}, &1)) do
          {:error, :timeout}
        else
          {:error, :unavailable}
        end

      ok_snapshots ->
        {:ok, ok_snapshots}
    end
  end

  defp orchestrator_sources(orchestrator) when is_list(orchestrator), do: orchestrator
  defp orchestrator_sources(orchestrator), do: [{nil, orchestrator}]

  defp request_refresh_results(orchestrator) do
    orchestrator_sources(orchestrator)
    |> Enum.reduce([], fn {workflow_name, server}, acc ->
      case Orchestrator.request_refresh(server) do
        :unavailable -> acc
        payload -> [{workflow_name, payload} | acc]
      end
    end)
    |> Enum.reverse()
  end

  defp single_state_payload(snapshot, generated_at) do
    %{
      generated_at: generated_at,
      counts: %{
        running: length(snapshot.running),
        retrying: length(snapshot.retrying)
      },
      running: Enum.map(snapshot.running, &running_entry_payload/1),
      retrying: Enum.map(snapshot.retrying, &retry_entry_payload/1),
      codex_totals: snapshot.codex_totals,
      rate_limits: snapshot.rate_limits
    }
  end

  defp multi_state_payload(snapshots, generated_at) do
    workflows =
      Enum.map(snapshots, fn {workflow_name, snapshot} ->
        %{
          workflow_name: workflow_name,
          counts: %{
            running: length(snapshot.running),
            retrying: length(snapshot.retrying)
          },
          running: Enum.map(snapshot.running, &running_entry_payload(&1, workflow_name)),
          retrying: Enum.map(snapshot.retrying, &retry_entry_payload(&1, workflow_name)),
          codex_totals: snapshot.codex_totals,
          rate_limits: snapshot.rate_limits,
          polling: Map.get(snapshot, :polling)
        }
      end)

    %{
      generated_at: generated_at,
      counts: %{
        running: Enum.reduce(workflows, 0, fn workflow, total -> total + workflow.counts.running end),
        retrying: Enum.reduce(workflows, 0, fn workflow, total -> total + workflow.counts.retrying end)
      },
      running: Enum.flat_map(workflows, & &1.running),
      retrying: Enum.flat_map(workflows, & &1.retrying),
      codex_totals: sum_codex_totals(workflows),
      rate_limits: Map.new(workflows, fn workflow -> {workflow.workflow_name, workflow.rate_limits} end),
      workflows: workflows
    }
  end

  defp sum_codex_totals(workflows) do
    Enum.reduce(workflows, %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0}, fn workflow, totals ->
      %{
        input_tokens: totals.input_tokens + Map.get(workflow.codex_totals, :input_tokens, 0),
        output_tokens: totals.output_tokens + Map.get(workflow.codex_totals, :output_tokens, 0),
        total_tokens: totals.total_tokens + Map.get(workflow.codex_totals, :total_tokens, 0),
        seconds_running: totals.seconds_running + Map.get(workflow.codex_totals, :seconds_running, 0)
      }
    end)
  end

  defp find_issue_entries(snapshots, issue_identifier) do
    Enum.reduce_while(snapshots, {nil, nil}, fn {workflow_name, snapshot}, _acc ->
      running =
        snapshot.running
        |> Enum.find(&(&1.identifier == issue_identifier))
        |> maybe_put_workflow_name(workflow_name)

      retry =
        snapshot.retrying
        |> Enum.find(&(&1.identifier == issue_identifier))
        |> maybe_put_workflow_name(workflow_name)

      if is_nil(running) and is_nil(retry) do
        {:cont, {nil, nil}}
      else
        {:halt, {running, retry}}
      end
    end)
  end

  defp issue_payload_body(issue_identifier, running, retry) do
    %{
      issue_identifier: issue_identifier,
      issue_id: issue_id_from_entries(running, retry),
      status: issue_status(running, retry),
      workspace: %{
        path: workspace_path(issue_identifier, running, retry),
        host: workspace_host(running, retry)
      },
      attempts: %{
        restart_count: restart_count(retry),
        current_retry_attempt: retry_attempt(retry)
      },
      running: running && running_issue_payload(running),
      retry: retry && retry_issue_payload(retry),
      logs: %{
        codex_session_logs: []
      },
      recent_events: (running && recent_events_payload(running)) || [],
      last_error: retry && retry.error,
      tracked: %{}
    }
  end

  defp issue_id_from_entries(running, retry),
    do: (running && running.issue_id) || (retry && retry.issue_id)

  defp restart_count(retry), do: max(retry_attempt(retry) - 1, 0)
  defp retry_attempt(nil), do: 0
  defp retry_attempt(retry), do: retry.attempt || 0

  defp issue_status(_running, nil), do: "running"
  defp issue_status(nil, _retry), do: "retrying"
  defp issue_status(_running, _retry), do: "running"

  defp running_entry_payload(entry, workflow_name \\ nil) do
    %{
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      state: entry.state,
      worker_host: Map.get(entry, :worker_host),
      workspace_path: Map.get(entry, :workspace_path),
      session_id: entry.session_id,
      turn_count: Map.get(entry, :turn_count, 0),
      last_event: entry.last_codex_event,
      last_message: summarize_message(entry.last_codex_message),
      started_at: iso8601(entry.started_at),
      last_event_at: iso8601(entry.last_codex_timestamp),
      tokens: %{
        input_tokens: entry.codex_input_tokens,
        output_tokens: entry.codex_output_tokens,
        total_tokens: entry.codex_total_tokens
      }
    }
    |> maybe_put_workflow_name_payload(workflow_name)
  end

  defp retry_entry_payload(entry, workflow_name \\ nil) do
    %{
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      attempt: entry.attempt,
      due_at: due_at_iso8601(entry.due_in_ms),
      error: entry.error,
      worker_host: Map.get(entry, :worker_host),
      workspace_path: Map.get(entry, :workspace_path)
    }
    |> maybe_put_workflow_name_payload(workflow_name)
  end

  defp running_issue_payload(running) do
    %{
      worker_host: Map.get(running, :worker_host),
      workspace_path: Map.get(running, :workspace_path),
      session_id: running.session_id,
      turn_count: Map.get(running, :turn_count, 0),
      state: running.state,
      started_at: iso8601(running.started_at),
      last_event: running.last_codex_event,
      last_message: summarize_message(running.last_codex_message),
      last_event_at: iso8601(running.last_codex_timestamp),
      tokens: %{
        input_tokens: running.codex_input_tokens,
        output_tokens: running.codex_output_tokens,
        total_tokens: running.codex_total_tokens
      }
    }
  end

  defp retry_issue_payload(retry) do
    %{
      attempt: retry.attempt,
      due_at: due_at_iso8601(retry.due_in_ms),
      error: retry.error,
      worker_host: Map.get(retry, :worker_host),
      workspace_path: Map.get(retry, :workspace_path)
    }
  end

  defp workspace_path(issue_identifier, running, retry) do
    (running && Map.get(running, :workspace_path)) ||
      (retry && Map.get(retry, :workspace_path)) ||
      Path.join(workspace_root_for_entry(running, retry), issue_identifier)
  end

  defp workspace_host(running, retry) do
    (running && Map.get(running, :worker_host)) || (retry && Map.get(retry, :worker_host))
  end

  defp recent_events_payload(running) do
    [
      %{
        at: iso8601(running.last_codex_timestamp),
        event: running.last_codex_event,
        message: summarize_message(running.last_codex_message)
      }
    ]
    |> Enum.reject(&is_nil(&1.at))
  end

  defp summarize_message(nil), do: nil
  defp summarize_message(message), do: StatusDashboard.humanize_codex_message(message)

  defp due_at_iso8601(due_in_ms) when is_integer(due_in_ms) do
    DateTime.utc_now()
    |> DateTime.add(div(due_in_ms, 1_000), :second)
    |> DateTime.truncate(:second)
    |> DateTime.to_iso8601()
  end

  defp due_at_iso8601(_due_in_ms), do: nil

  defp workspace_root_for_entry(running, retry) do
    workflow_name =
      (running && Map.get(running, :workflow_name)) || (retry && Map.get(retry, :workflow_name))

    case workflow_name do
      name when is_binary(name) -> Config.settings!(base_workflow_name(name)).workspace.root
      _ -> Config.settings!().workspace.root
    end
  end

  # Registry keys may include a project-id suffix (e.g. "WORKFLOW:4").
  # Strip it to get the base workflow name used by Workflow/Config.
  defp base_workflow_name(name) do
    case String.split(name, ":", parts: 2) do
      [base, suffix] ->
        case Integer.parse(suffix) do
          {_id, ""} -> base
          _ -> name
        end

      _ ->
        name
    end
  end

  defp maybe_put_workflow_name(nil, _workflow_name), do: nil
  defp maybe_put_workflow_name(entry, nil), do: entry
  defp maybe_put_workflow_name(entry, workflow_name), do: Map.put(entry, :workflow_name, workflow_name)

  defp maybe_put_workflow_name_payload(payload, nil), do: payload
  defp maybe_put_workflow_name_payload(payload, workflow_name), do: Map.put(payload, :workflow_name, workflow_name)

  @spec history_payload(keyword()) :: map()
  def history_payload(opts \\ []) do
    sessions = Store.list_sessions(Keyword.take(opts, [:limit, :offset, :issue_identifier, :status, :project_id]))

    %{
      sessions:
        Enum.map(sessions, fn s ->
          %{
            id: s.id,
            issue_identifier: s.issue_identifier,
            issue_title: s.issue_title,
            session_id: s.session_id,
            status: s.status,
            started_at: iso8601(s.started_at),
            ended_at: iso8601(s.ended_at),
            turn_count: s.turn_count,
            input_tokens: s.input_tokens,
            output_tokens: s.output_tokens,
            total_tokens: s.total_tokens,
            worker_host: s.worker_host,
            error: s.error
          }
        end)
    }
  end

  @spec historical_messages_payload(integer()) :: {:ok, map()} | {:error, :not_found}
  def historical_messages_payload(db_session_id) do
    case Store.get_session(db_session_id) do
      nil ->
        {:error, :not_found}

      session ->
        messages =
          Store.get_session_messages(db_session_id)
          |> Enum.map(fn m ->
            %{
              id: m.seq,
              timestamp: iso8601(m.timestamp),
              type: m.type,
              content: m.content,
              metadata: decode_metadata(m.metadata)
            }
          end)

        {:ok,
         %{
           session: %{
             id: session.id,
             issue_identifier: session.issue_identifier,
             issue_title: session.issue_title,
             session_id: session.session_id,
             status: session.status,
             started_at: iso8601(session.started_at),
             ended_at: iso8601(session.ended_at),
             turn_count: session.turn_count,
             total_tokens: session.total_tokens
           },
           messages: messages
         }}
    end
  end

  defp decode_metadata(nil), do: %{}

  defp decode_metadata(json) when is_binary(json) do
    case Jason.decode(json) do
      {:ok, map} when is_map(map) -> atomize_metadata_keys(map)
      _ -> %{}
    end
  end

  defp decode_metadata(_), do: %{}

  defp atomize_metadata_keys(map) when is_map(map) do
    Map.new(map, fn {k, v} -> {String.to_existing_atom(k), v} end)
  rescue
    ArgumentError -> map
  end

  defp iso8601(%DateTime{} = datetime) do
    datetime
    |> DateTime.truncate(:second)
    |> DateTime.to_iso8601()
  end

  defp iso8601(_datetime), do: nil
end
