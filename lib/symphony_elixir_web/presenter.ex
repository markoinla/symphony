defmodule SymphonyElixirWeb.Presenter do
  @moduledoc """
  Shared projections for the observability API and dashboard.
  """

  alias SymphonyElixir.{Config, Orchestrator, SessionLog, StatusDashboard, Store, WorkflowStore}

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

  @spec messages_payload(String.t(), GenServer.name() | [{String.t(), GenServer.name()}], timeout()) :: {:ok, map()}
  def messages_payload(issue_identifier, orchestrator, snapshot_timeout_ms) do
    payload =
      case issue_payload(issue_identifier, orchestrator, snapshot_timeout_ms) do
        {:ok, issue_payload} -> issue_payload
        {:error, _reason} -> nil
      end

    {:ok, timeline_payload(issue_identifier, payload)}
  end

  @spec message_payload(map()) :: map()
  def message_payload(msg) do
    %{
      id: msg.id,
      timestamp: iso8601(msg.timestamp),
      type: to_string(msg.type),
      content: msg.content,
      metadata: msg.metadata
    }
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
    sources = orchestrator_sources(orchestrator)

    snapshots =
      Enum.reduce(sources, [], fn {workflow_name, server}, acc ->
        case Orchestrator.snapshot(server, snapshot_timeout_ms) do
          %{} = snapshot -> [{workflow_name, snapshot} | acc]
          :timeout -> [{:timeout, workflow_name} | acc]
          :unavailable -> [{:unavailable, workflow_name} | acc]
        end
      end)
      |> Enum.reverse()

    ok_snapshots =
      Enum.filter(snapshots, fn
        {workflow_name, %{} = _snapshot} when is_binary(workflow_name) or is_nil(workflow_name) -> true
        _ -> false
      end)

    case ok_snapshots do
      [] -> resolve_empty_snapshots(snapshots)
      ok_snapshots -> {:ok, ok_snapshots}
    end
  end

  defp resolve_empty_snapshots(snapshots) do
    cond do
      Enum.any?(snapshots, &match?({:timeout, _}, &1)) ->
        {:error, :timeout}

      Enum.any?(snapshots, &match?({:unavailable, _}, &1)) ->
        {:error, :unavailable}

      true ->
        # No orchestrators registered yet (e.g. during startup) — return empty
        {:ok, [{nil, empty_snapshot()}]}
    end
  end

  defp orchestrator_sources(orchestrator) when is_list(orchestrator), do: orchestrator
  defp orchestrator_sources(orchestrator), do: [{nil, orchestrator}]

  defp empty_snapshot do
    %{
      running: [],
      retrying: [],
      engine_totals: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
      rate_limits: %{}
    }
  end

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
      engine_totals: snapshot.engine_totals,
      rate_limits: snapshot.rate_limits,
      loaded_workflows: loaded_workflows_payload()
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
          cooldowns: Map.get(snapshot, :cooldowns, []),
          capacity: Map.get(snapshot, :capacity),
          engine_totals: snapshot.engine_totals,
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
      engine_totals: sum_engine_totals(workflows),
      rate_limits: Map.new(workflows, fn workflow -> {workflow.workflow_name, workflow.rate_limits} end),
      workflows: workflows,
      loaded_workflows: loaded_workflows_payload()
    }
  end

  defp loaded_workflows_payload do
    WorkflowStore.workflow_names()
    |> Enum.map(fn name ->
      %{name: name, display_name: workflow_display_name(name)}
    end)
  end

  defp workflow_display_name(name) when is_binary(name) do
    name
    |> String.replace(~r/[_-]/, " ")
    |> String.split()
    |> Enum.map_join(" ", &String.capitalize/1)
  end

  defp sum_engine_totals(workflows) do
    Enum.reduce(workflows, %{input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0}, fn workflow, totals ->
      %{
        input_tokens: totals.input_tokens + Map.get(workflow.engine_totals, :input_tokens, 0),
        output_tokens: totals.output_tokens + Map.get(workflow.engine_totals, :output_tokens, 0),
        total_tokens: totals.total_tokens + Map.get(workflow.engine_totals, :total_tokens, 0),
        seconds_running: totals.seconds_running + Map.get(workflow.engine_totals, :seconds_running, 0)
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
      issue_title: issue_title_from_entries(running, retry),
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

  defp issue_title_from_entries(running, retry) do
    running_title =
      case running do
        %{issue: %{title: title}} when is_binary(title) and title != "" -> title
        _ -> nil
      end

    retry_title =
      case retry do
        %{issue: %{title: title}} when is_binary(title) and title != "" -> title
        _ -> nil
      end

    running_title || retry_title
  end

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
      project_id: Map.get(entry, :project_id),
      project_name: Map.get(entry, :project_name),
      state: entry.state,
      worker_host: Map.get(entry, :worker_host),
      workspace_path: Map.get(entry, :workspace_path),
      session_id: entry.session_id,
      turn_count: Map.get(entry, :turn_count, 0),
      last_event: entry.last_engine_event,
      last_message: summarize_message(entry.last_engine_message),
      started_at: iso8601(entry.started_at),
      last_event_at: iso8601(entry.last_engine_timestamp),
      tokens: %{
        input_tokens: entry.engine_input_tokens,
        output_tokens: entry.engine_output_tokens,
        total_tokens: entry.engine_total_tokens
      }
    }
    |> maybe_put_workflow_name_payload(workflow_name)
  end

  defp retry_entry_payload(entry, workflow_name \\ nil) do
    %{
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      project_id: Map.get(entry, :project_id),
      project_name: Map.get(entry, :project_name),
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
      last_event: running.last_engine_event,
      last_message: summarize_message(running.last_engine_message),
      last_event_at: iso8601(running.last_engine_timestamp),
      tokens: %{
        input_tokens: running.engine_input_tokens,
        output_tokens: running.engine_output_tokens,
        total_tokens: running.engine_total_tokens
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
        at: iso8601(running.last_engine_timestamp),
        event: running.last_engine_event,
        message: summarize_message(running.last_engine_message)
      }
    ]
    |> Enum.reject(&is_nil(&1.at))
  end

  defp summarize_message(nil), do: nil
  defp summarize_message(message), do: StatusDashboard.humanize_engine_message(message)

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

  @spec session_debug_payload(integer()) :: {:ok, map()} | {:error, :not_found}
  def session_debug_payload(db_session_id) do
    case Store.get_session_debug(db_session_id) do
      nil ->
        {:error, :not_found}

      session ->
        messages =
          Enum.map(session.messages, fn m ->
            %{
              seq: m.seq,
              type: m.type,
              content: m.content,
              metadata: decode_metadata(m.metadata),
              timestamp: iso8601(m.timestamp)
            }
          end)

        error_message_count =
          Enum.count(session.messages, fn m -> m.type == "error" end)

        duration_seconds =
          case {session.started_at, session.ended_at} do
            {%DateTime{} = started, %DateTime{} = ended} ->
              DateTime.diff(ended, started, :second)

            _ ->
              nil
          end

        {:ok,
         %{
           session: %{
             id: session.id,
             issue_id: session.issue_id,
             issue_identifier: session.issue_identifier,
             issue_title: session.issue_title,
             session_id: session.session_id,
             workflow_name: session.workflow_name,
             status: session.status,
             error: session.error,
             stderr: session.stderr,
             started_at: iso8601(session.started_at),
             ended_at: iso8601(session.ended_at),
             turn_count: session.turn_count,
             input_tokens: session.input_tokens,
             output_tokens: session.output_tokens,
             total_tokens: session.total_tokens,
             worker_host: session.worker_host,
             workspace_path: session.workspace_path,
             config_snapshot: session.config_snapshot,
             hook_results: session.hook_results,
             dispatch_source: session.dispatch_source,
             project_id: session.project_id,
             error_category: session.error_category
           },
           messages: messages,
           summary: %{
             message_count: length(session.messages),
             error_message_count: error_message_count,
             duration_seconds: duration_seconds
           }
         }}
    end
  end

  @spec history_payload(keyword()) :: map()
  def history_payload(opts \\ []) do
    sessions = Store.list_sessions(Keyword.take(opts, [:limit, :offset, :issue_identifier, :status, :project_id, :workflow_name, :org_id]))

    %{
      sessions: Enum.map(sessions, &session_summary_payload/1)
    }
  end

  @spec projects_payload(keyword()) :: map()
  def projects_payload(opts \\ []) do
    %{projects: Enum.map(Store.list_projects(opts), &project_payload/1)}
  end

  @spec project_lookup_payload(integer()) :: {:ok, map()} | {:error, :not_found}
  def project_lookup_payload(id) when is_integer(id) do
    case Store.get_project(id) do
      nil -> {:error, :not_found}
      project -> {:ok, %{project: project_payload(project)}}
    end
  end

  @hidden_setting_keys ~w(
    linear_oauth.access_token
    linear_oauth.refresh_token
    linear_oauth.client_secret
    linear_oauth.state
    github_oauth.access_token
    github_oauth.refresh_token
    github_oauth.client_secret
    github_oauth.state
    proxy.registration_secret
    proxy_oauth.linear.state
    proxy_oauth.linear.code_verifier
    proxy_oauth.github.state
    proxy_oauth.github.code_verifier
  )

  @spec settings_payload() :: map()
  def settings_payload do
    settings =
      Store.list_settings()
      |> Enum.reject(fn setting -> setting.key in @hidden_setting_keys end)
      |> Enum.sort_by(& &1.key)
      |> Enum.map(fn setting ->
        %{key: setting.key, value: setting.value}
      end)

    %{settings: settings, agent_defaults: agent_defaults_payload()}
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

  defp agent_defaults_payload do
    agent_config =
      case Config.workflow_settings() do
        {:ok, settings} -> settings.agent
        {:error, _reason} -> Config.default_settings().agent
      end

    %{
      max_concurrent_agents: agent_config.max_concurrent_agents,
      max_turns: agent_config.max_turns
    }
  end

  defp atomize_metadata_keys(map) when is_map(map) do
    Map.new(map, fn {k, v} -> {String.to_existing_atom(k), v} end)
  rescue
    ArgumentError -> map
  end

  defp timeline_payload(issue_identifier, payload) do
    {issue_id, current_session_id} = extract_session_keys(payload)

    historical_sessions =
      issue_identifier
      |> load_past_sessions(current_session_id)
      |> Enum.map(&historical_session_payload/1)

    live_session =
      live_session_payload(issue_id, current_session_id, payload)

    sessions =
      case live_session do
        nil -> historical_sessions
        session -> historical_sessions ++ [session]
      end

    %{
      issue_identifier: issue_identifier,
      issue_id: issue_id,
      issue_title: timeline_issue_title(sessions, payload),
      status: payload_status(payload, sessions),
      active_session_id: current_session_id,
      sessions: sessions
    }
  end

  defp load_past_sessions(issue_identifier, current_session_id) do
    Store.list_sessions(issue_identifier: issue_identifier, limit: 50)
    |> Enum.reject(fn session -> current_session_id && session.session_id == current_session_id end)
    |> Enum.reverse()
  end

  defp historical_session_payload(session) do
    messages =
      session.id
      |> Store.get_session_messages()
      |> Enum.map(fn message ->
        %{
          id: message.seq,
          timestamp: iso8601(message.timestamp),
          type: message.type,
          content: message.content,
          metadata: decode_metadata(message.metadata)
        }
      end)

    session_summary_payload(session)
    |> Map.put(:live, false)
    |> Map.put(:messages, messages)
  end

  defp live_session_payload(issue_id, current_session_id, payload)
       when is_binary(issue_id) and is_binary(current_session_id) do
    running = live_running(payload)

    %{
      id: nil,
      issue_identifier: live_issue_identifier(payload),
      issue_title: nil,
      session_id: current_session_id,
      status: "running",
      started_at: Map.get(running, :started_at),
      ended_at: nil,
      turn_count: Map.get(running, :turn_count),
      input_tokens: live_token(running, :input_tokens),
      output_tokens: live_token(running, :output_tokens),
      total_tokens: live_token(running, :total_tokens),
      worker_host: Map.get(running, :worker_host),
      error: nil,
      workflow_name: Map.get(running, :workflow_name),
      live: true,
      messages: live_session_messages(issue_id, current_session_id)
    }
  end

  defp live_session_payload(_issue_id, _current_session_id, _payload), do: nil

  defp live_session_messages(issue_id, current_session_id) do
    case SessionLog.get_messages(issue_id, current_session_id) do
      {:ok, items} -> Enum.map(items, &message_payload/1)
      {:error, _reason} -> []
    end
  end

  defp live_running(%{running: running}) when is_map(running), do: running
  defp live_running(_payload), do: %{}

  defp live_issue_identifier(%{issue_identifier: issue_identifier})
       when is_binary(issue_identifier),
       do: issue_identifier

  defp live_issue_identifier(_payload), do: nil

  defp live_token(running, key), do: get_in(running, [:tokens, key])

  defp timeline_issue_title([], payload) when is_map(payload) do
    payload[:issue_title]
  end

  defp timeline_issue_title(sessions, payload) do
    sessions
    |> Enum.reverse()
    |> Enum.find_value(payload && payload[:issue_title], fn session ->
      case session do
        %{issue_title: title} when is_binary(title) and title != "" -> title
        _ -> nil
      end
    end)
  end

  defp payload_status(%{status: status}, _sessions) when is_binary(status), do: status

  defp payload_status(_payload, sessions) do
    sessions
    |> Enum.reverse()
    |> Enum.find_value("idle", fn session ->
      case session do
        %{status: status} when is_binary(status) and status != "" -> status
        _ -> nil
      end
    end)
  end

  defp extract_session_keys(nil), do: {nil, nil}

  defp extract_session_keys(payload) do
    issue_id = payload[:issue_id]

    session_id =
      case payload[:running] do
        %{session_id: sid} when is_binary(sid) -> sid
        _ -> nil
      end

    {issue_id, session_id}
  end

  defp project_payload(project) do
    %{
      id: project.id,
      name: project.name,
      linear_project_id: project.linear_project_id,
      linear_project_slug: project.linear_project_slug,
      linear_organization_slug: project.linear_organization_slug,
      linear_filter_by: project.linear_filter_by,
      linear_label_name: project.linear_label_name,
      github_repo: project.github_repo,
      github_branch: project.github_branch,
      workspace_root: project.workspace_root,
      env_vars: project.env_vars,
      created_at: iso8601(project.created_at),
      updated_at: iso8601(project.updated_at)
    }
  end

  defp session_summary_payload(session) do
    project = if Ecto.assoc_loaded?(session.project), do: session.project, else: nil

    %{
      id: session.id,
      issue_identifier: session.issue_identifier,
      issue_title: session.issue_title,
      session_id: session.session_id,
      status: session.status,
      started_at: iso8601(session.started_at),
      ended_at: iso8601(session.ended_at),
      turn_count: session.turn_count,
      input_tokens: session.input_tokens,
      output_tokens: session.output_tokens,
      total_tokens: session.total_tokens,
      worker_host: session.worker_host,
      error: session.error,
      workflow_name: session.workflow_name,
      error_category: session.error_category,
      github_branch: session.github_branch,
      github_repo: if(project, do: project.github_repo),
      project_name: if(project, do: project.name)
    }
  end

  defp iso8601(%DateTime{} = datetime) do
    datetime
    |> DateTime.truncate(:second)
    |> DateTime.to_iso8601()
  end

  defp iso8601(_datetime), do: nil
end
