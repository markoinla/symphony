defmodule SymphonyElixirWeb.Presenter do
  @moduledoc """
  Shared projections for the observability API and dashboard.
  """

  alias SymphonyElixir.{Config, Orchestrator, SessionLog, StatusDashboard, Store}

  @spec state_payload(GenServer.name(), timeout()) :: map()
  def state_payload(orchestrator, snapshot_timeout_ms) do
    generated_at = DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()

    case Orchestrator.snapshot(orchestrator, snapshot_timeout_ms) do
      %{} = snapshot ->
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

      :timeout ->
        %{generated_at: generated_at, error: %{code: "snapshot_timeout", message: "Snapshot timed out"}}

      :unavailable ->
        %{generated_at: generated_at, error: %{code: "snapshot_unavailable", message: "Snapshot unavailable"}}
    end
  end

  @spec issue_payload(String.t(), GenServer.name(), timeout()) :: {:ok, map()} | {:error, :issue_not_found}
  def issue_payload(issue_identifier, orchestrator, snapshot_timeout_ms) when is_binary(issue_identifier) do
    case Orchestrator.snapshot(orchestrator, snapshot_timeout_ms) do
      %{} = snapshot ->
        running = Enum.find(snapshot.running, &(&1.identifier == issue_identifier))
        retry = Enum.find(snapshot.retrying, &(&1.identifier == issue_identifier))

        if is_nil(running) and is_nil(retry) do
          {:error, :issue_not_found}
        else
          {:ok, issue_payload_body(issue_identifier, running, retry)}
        end

      _ ->
        {:error, :issue_not_found}
    end
  end

  @spec messages_payload(String.t(), GenServer.name(), timeout()) ::
          {:ok, map()} | {:error, :issue_not_found | :session_log_not_found}
  def messages_payload(issue_identifier, orchestrator, snapshot_timeout_ms) do
    case issue_payload(issue_identifier, orchestrator, snapshot_timeout_ms) do
      {:ok, payload} ->
        issue_id = payload[:issue_id]

        session_id =
          case payload[:running] do
            %{session_id: sid} when is_binary(sid) -> sid
            _ -> nil
          end

        if issue_id && session_id do
          case SessionLog.get_messages(issue_id, session_id) do
            {:ok, msgs} ->
              {:ok,
               %{
                 issue_identifier: issue_identifier,
                 session_id: session_id,
                 messages: Enum.map(msgs, &message_payload/1)
               }}

            {:error, :not_found} ->
              {:error, :session_log_not_found}
          end
        else
          {:error, :session_log_not_found}
        end

      {:error, :issue_not_found} ->
        {:error, :issue_not_found}
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

  @spec refresh_payload(GenServer.name()) :: {:ok, map()} | {:error, :unavailable}
  def refresh_payload(orchestrator) do
    case Orchestrator.request_refresh(orchestrator) do
      :unavailable ->
        {:error, :unavailable}

      payload ->
        {:ok, Map.update!(payload, :requested_at, &DateTime.to_iso8601/1)}
    end
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

  defp running_entry_payload(entry) do
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
  end

  defp retry_entry_payload(entry) do
    %{
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      attempt: entry.attempt,
      due_at: due_at_iso8601(entry.due_in_ms),
      error: entry.error,
      worker_host: Map.get(entry, :worker_host),
      workspace_path: Map.get(entry, :workspace_path)
    }
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
      Path.join(Config.settings!().workspace.root, issue_identifier)
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

  @spec history_payload(keyword()) :: map()
  def history_payload(opts \\ []) do
    sessions = Store.list_sessions(opts)

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
          |> merge_consecutive_messages()

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

  @doc """
  Merge consecutive messages of the same streamable type (response, thinking)
  into single messages. Handles historical data persisted before delta aggregation.
  """
  @spec merge_consecutive_messages([map()]) :: [map()]
  def merge_consecutive_messages(messages) do
    messages
    |> Enum.reduce([], fn msg, acc ->
      case {msg, acc} do
        {%{type: type}, [%{type: type} = prev | rest]} when type in ["response", "thinking", "reasoning_summary"] ->
          [%{prev | content: prev.content <> msg.content} | rest]

        {%{type: type}, [%{type: type} = prev | rest]} when type in [:response, :thinking, :reasoning_summary] ->
          [%{prev | content: prev.content <> msg.content} | rest]

        _ ->
          [msg | acc]
      end
    end)
    |> Enum.reverse()
  end

  defp iso8601(%DateTime{} = datetime) do
    datetime
    |> DateTime.truncate(:second)
    |> DateTime.to_iso8601()
  end

  defp iso8601(_datetime), do: nil
end
