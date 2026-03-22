defmodule SymphonyElixir.AgentRunner do
  @moduledoc """
  Executes a single Linear issue in its workspace using the configured engine backend.
  """

  require Logger
  alias SymphonyElixir.Engine

  alias SymphonyElixir.{
    CommentWatch,
    Config,
    DashboardLinks,
    Linear.Issue,
    PromptBuilder,
    SessionLog,
    Tracker,
    Workspace
  }

  @type worker_host :: String.t() | nil

  @spec run(map(), pid() | nil, keyword()) :: :ok | no_return()
  def run(issue, engine_update_recipient \\ nil, opts \\ []) do
    worker_hosts =
      candidate_worker_hosts(Keyword.get(opts, :worker_host), Config.settings!().worker.ssh_hosts)

    Logger.info("Starting agent run for #{issue_context(issue)} worker_hosts=#{inspect(worker_hosts_for_log(worker_hosts))}")

    case run_on_worker_hosts(issue, engine_update_recipient, opts, worker_hosts) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.error("Agent run failed for #{issue_context(issue)}: #{inspect(reason)}")
        raise RuntimeError, "Agent run failed for #{issue_context(issue)}: #{inspect(reason)}"
    end
  end

  defp run_on_worker_hosts(issue, engine_update_recipient, opts, [worker_host | rest]) do
    case run_on_worker_host(issue, engine_update_recipient, opts, worker_host) do
      :ok ->
        :ok

      {:error, reason} when rest != [] ->
        Logger.warning("Agent run failed for #{issue_context(issue)} worker_host=#{worker_host_for_log(worker_host)} reason=#{inspect(reason)}; trying next worker host")
        run_on_worker_hosts(issue, engine_update_recipient, opts, rest)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp run_on_worker_hosts(_issue, _engine_update_recipient, _opts, []), do: {:error, :no_worker_hosts_available}

  defp run_on_worker_host(issue, engine_update_recipient, opts, worker_host) do
    Logger.info("Starting worker attempt for #{issue_context(issue)} worker_host=#{worker_host_for_log(worker_host)}")

    case Workspace.create_for_issue_with_status(issue, worker_host) do
      {:ok, workspace, created?} ->
        send_worker_runtime_info(engine_update_recipient, issue, worker_host, workspace)
        maybe_notify_workspace_ready(issue, workspace, worker_host, created?)

        try do
          with :ok <- Workspace.run_before_run_hook(workspace, issue, worker_host) do
            run_engine_turns(workspace, issue, engine_update_recipient, opts, worker_host)
          end
        after
          Workspace.run_after_run_hook(workspace, issue, worker_host)
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp engine_message_handler(recipient, issue) do
    fn message ->
      send_engine_update(recipient, issue, message)
    end
  end

  defp engine_message_handler_with_log(recipient, %Issue{id: issue_id} = issue, session_id)
       when is_binary(issue_id) and is_binary(session_id) do
    fn message ->
      send_engine_update(recipient, issue, message)
      SessionLog.append(issue_id, session_id, message)
    end
  end

  defp engine_message_handler_with_log(recipient, issue, _session_id) do
    engine_message_handler(recipient, issue)
  end

  defp send_engine_update(recipient, %Issue{id: issue_id}, message)
       when is_binary(issue_id) and is_pid(recipient) do
    send(recipient, {:engine_worker_update, issue_id, message})
    :ok
  end

  defp send_engine_update(_recipient, _issue, _message), do: :ok

  defp send_worker_runtime_info(recipient, %Issue{id: issue_id}, worker_host, workspace)
       when is_binary(issue_id) and is_pid(recipient) and is_binary(workspace) do
    send(
      recipient,
      {:worker_runtime_info, issue_id,
       %{
         worker_host: worker_host,
         workspace_path: workspace
       }}
    )

    :ok
  end

  defp send_worker_runtime_info(_recipient, _issue, _worker_host, _workspace), do: :ok

  defp send_comment_watch_update(recipient, %Issue{id: issue_id}, comment_watch_state)
       when is_binary(issue_id) and is_pid(recipient) do
    send(recipient, {:comment_watch_state, issue_id, comment_watch_state})
    :ok
  end

  defp send_comment_watch_update(_recipient, _issue, _comment_watch_state), do: :ok

  defp notify_workspace_ready(%Issue{id: issue_id} = issue, workspace, worker_host)
       when is_binary(issue_id) do
    maybe_tag_issue_pickup(issue)
    host = if is_binary(worker_host), do: worker_host, else: node_hostname()
    body = "Workspace ready: `#{host}:#{workspace}`"

    case Tracker.create_comment(issue_id, body) do
      {:ok, _comment_id} ->
        Logger.info("Posted workspace-ready comment for #{issue_context(issue)}")

      {:error, reason} ->
        Logger.warning("Failed to post workspace-ready comment for #{issue_context(issue)}: #{inspect(reason)}")
    end

    maybe_attach_session_resource(issue)
  end

  defp notify_workspace_ready(_issue, _workspace, _worker_host), do: :ok

  defp maybe_notify_workspace_ready(issue, workspace, worker_host, true) do
    notify_workspace_ready(issue, workspace, worker_host)
  end

  defp maybe_notify_workspace_ready(_issue, _workspace, _worker_host, false), do: :ok

  defp maybe_attach_session_resource(%Issue{id: issue_id, identifier: issue_identifier} = issue)
       when is_binary(issue_id) and is_binary(issue_identifier) do
    url = DashboardLinks.session_issue_url(issue_identifier)
    title = DashboardLinks.session_issue_title()

    case Tracker.ensure_issue_resource_link(issue_id, url, title) do
      :ok ->
        Logger.info("Ensured session resource link for #{issue_context(issue)} url=#{url}")

      {:error, reason} ->
        Logger.warning("Failed to ensure session resource link for #{issue_context(issue)} url=#{url}: #{inspect(reason)}")
    end
  end

  defp maybe_attach_session_resource(_issue), do: :ok

  defp maybe_tag_issue_pickup(%Issue{id: issue_id, labels: labels} = issue)
       when is_binary(issue_id) and is_list(labels) do
    case configured_pickup_label_name() do
      nil ->
        :ok

      label_name ->
        maybe_add_pickup_label(issue, labels, label_name)
    end
  end

  defp maybe_tag_issue_pickup(_issue), do: :ok

  defp maybe_add_pickup_label(issue, labels, label_name) do
    if issue_has_label?(labels, label_name) do
      :ok
    else
      add_pickup_label(issue, label_name)
    end
  end

  defp add_pickup_label(%Issue{id: issue_id} = issue, label_name) when is_binary(issue_id) do
    case Tracker.add_issue_label(issue_id, label_name) do
      :ok ->
        Logger.info("Added pickup label to #{issue_context(issue)} label=#{inspect(label_name)}")

      {:error, reason} ->
        Logger.warning("Failed to add pickup label to #{issue_context(issue)} label=#{inspect(label_name)}: #{inspect(reason)}")
    end
  end

  defp configured_pickup_label_name do
    case Config.settings!().tracker.picked_up_label_name do
      value when is_binary(value) ->
        value
        |> String.trim()
        |> case do
          "" -> nil
          trimmed -> trimmed
        end

      _ ->
        nil
    end
  end

  defp issue_has_label?(labels, label_name) when is_list(labels) and is_binary(label_name) do
    wanted_label = normalize_issue_state(label_name)
    Enum.any?(labels, &(normalize_issue_state(&1) == wanted_label))
  end

  defp node_hostname do
    {:ok, hostname} = :inet.gethostname()
    List.to_string(hostname)
  end

  defp run_engine_turns(workspace, issue, engine_update_recipient, opts, worker_host) do
    max_turns = Keyword.get(opts, :max_turns, Config.settings!().agent.max_turns)
    issue_state_fetcher = Keyword.get(opts, :issue_state_fetcher, &Tracker.fetch_issue_states_by_ids/1)
    project_id = Keyword.get(opts, :project_id)
    comment_watch_state = opts |> Keyword.get(:comment_watch_state) |> CommentWatch.seed(issue.comments)

    with {:ok, session} <- Engine.engine_module().start_session(workspace, worker_host: worker_host) do
      session_id = session[:session_id] || "session_#{System.unique_integer([:positive])}"
      start_session_log(issue, session_id, project_id)
      send_comment_watch_update(engine_update_recipient, issue, comment_watch_state)

      try do
        do_run_engine_turns(
          session,
          workspace,
          issue,
          engine_update_recipient,
          opts,
          issue_state_fetcher,
          1,
          max_turns,
          session_id,
          comment_watch_state,
          []
        )
      after
        stop_session_log(issue, session_id)
        Engine.engine_module().stop_session(session)
      end
    end
  end

  defp start_session_log(%Issue{id: issue_id} = issue, session_id, project_id) when is_binary(issue_id) and is_binary(session_id) do
    case SessionLog.start_link(issue_id: issue_id, session_id: session_id, issue_identifier: issue.identifier, issue_title: issue.title, project_id: project_id) do
      {:ok, _pid} ->
        :ok

      {:error, {:already_started, _pid}} ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to start SessionLog for issue_id=#{issue_id} session_id=#{session_id}: #{inspect(reason)}")
        :ok
    end
  end

  defp start_session_log(_issue, _session_id, _project_id), do: :ok

  defp stop_session_log(%Issue{id: issue_id}, session_id) when is_binary(issue_id) and is_binary(session_id) do
    SessionLog.stop(issue_id, session_id)
  end

  defp stop_session_log(_issue, _session_id), do: :ok

  # credo:disable-for-next-line
  defp do_run_engine_turns(
         app_session,
         workspace,
         issue,
         engine_update_recipient,
         opts,
         issue_state_fetcher,
         turn_number,
         max_turns,
         session_id,
         comment_watch_state,
         new_comments
       ) do
    prompt = build_turn_prompt(issue, opts, turn_number, max_turns, new_comments)

    with {:ok, turn_session} <-
           Engine.engine_module().run_turn(
             app_session,
             prompt,
             issue,
             on_message: engine_message_handler_with_log(engine_update_recipient, issue, session_id)
           ) do
      Logger.info("Completed agent run for #{issue_context(issue)} session_id=#{turn_session[:session_id]} workspace=#{workspace} turn=#{turn_number}/#{max_turns}")

      case continue_with_issue?(issue, issue_state_fetcher, comment_watch_state) do
        {:continue, refreshed_issue, next_comment_watch_state, unseen_comments} when turn_number < max_turns ->
          Logger.info("Continuing agent run for #{issue_context(refreshed_issue)} after normal turn completion turn=#{turn_number}/#{max_turns}")
          send_comment_watch_update(engine_update_recipient, refreshed_issue, next_comment_watch_state)

          do_run_engine_turns(
            app_session,
            workspace,
            refreshed_issue,
            engine_update_recipient,
            opts,
            issue_state_fetcher,
            turn_number + 1,
            max_turns,
            session_id,
            next_comment_watch_state,
            unseen_comments
          )

        {:continue, refreshed_issue, next_comment_watch_state, _unseen_comments} ->
          Logger.info("Reached agent.max_turns for #{issue_context(refreshed_issue)} with issue still active; returning control to orchestrator")
          send_comment_watch_update(engine_update_recipient, refreshed_issue, next_comment_watch_state)

          :ok

        {:done, refreshed_issue, next_comment_watch_state} ->
          send_comment_watch_update(engine_update_recipient, refreshed_issue, next_comment_watch_state)
          :ok

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  @doc false
  @spec build_turn_prompt_for_test(Issue.t(), keyword(), pos_integer(), pos_integer(), list()) :: String.t()
  def build_turn_prompt_for_test(issue, opts, turn_number, max_turns, new_comments) do
    build_turn_prompt(issue, opts, turn_number, max_turns, new_comments)
  end

  defp build_turn_prompt(issue, opts, 1, _max_turns, _new_comments), do: PromptBuilder.build_prompt(issue, opts)

  defp build_turn_prompt(_issue, _opts, turn_number, max_turns, new_comments) do
    comment_section =
      case CommentWatch.continuation_section(new_comments) do
        nil -> ""
        section -> section <> "\n"
      end

    """
    #{comment_section}Continuation guidance:

    - The previous Codex turn completed normally, but the Linear issue is still in an active state.
    - This is continuation turn ##{turn_number} of #{max_turns} for the current agent run.
    - Resume from the current workspace and workpad state instead of restarting from scratch.
    - The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
    - Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.
    """
    |> String.trim_leading()
  end

  @doc false
  @spec continue_with_issue_for_test(Issue.t(), (list(String.t()) -> term()), CommentWatch.state() | nil) ::
          {:continue, Issue.t(), CommentWatch.state(), list()} | {:done, Issue.t(), CommentWatch.state()} | {:error, term()}
  def continue_with_issue_for_test(%Issue{} = issue, issue_state_fetcher, comment_watch_state)
      when is_function(issue_state_fetcher, 1) do
    continue_with_issue?(issue, issue_state_fetcher, comment_watch_state)
  end

  defp continue_with_issue?(%Issue{id: issue_id} = issue, issue_state_fetcher, comment_watch_state)
       when is_binary(issue_id) do
    case issue_state_fetcher.([issue_id]) do
      {:ok, [%Issue{} = refreshed_issue | _]} ->
        unseen_comments = CommentWatch.unseen_external_comments(comment_watch_state, refreshed_issue.comments)
        next_comment_watch_state = CommentWatch.remember(comment_watch_state, refreshed_issue.comments)

        if active_issue_state?(refreshed_issue.state) and issue_still_matches_label_filter?(refreshed_issue) do
          {:continue, refreshed_issue, next_comment_watch_state, unseen_comments}
        else
          {:done, refreshed_issue, next_comment_watch_state}
        end

      {:ok, []} ->
        {:done, issue, CommentWatch.normalize_state_for_test(comment_watch_state)}

      {:error, reason} ->
        {:error, {:issue_state_refresh_failed, reason}}
    end
  end

  defp continue_with_issue?(issue, _issue_state_fetcher, comment_watch_state),
    do: {:done, issue, CommentWatch.normalize_state_for_test(comment_watch_state)}

  defp issue_still_matches_label_filter?(%Issue{labels: labels}) do
    tracker = Config.settings!().tracker

    case tracker.filter_by do
      "label" when is_binary(tracker.label_name) ->
        tracker.label_name in labels

      _ ->
        true
    end
  end

  defp active_issue_state?(state_name) when is_binary(state_name) do
    normalized_state = normalize_issue_state(state_name)

    Config.settings!().tracker.active_states
    |> Enum.any?(fn active_state -> normalize_issue_state(active_state) == normalized_state end)
  end

  defp active_issue_state?(_state_name), do: false

  defp candidate_worker_hosts(nil, []), do: [nil]

  defp candidate_worker_hosts(preferred_host, configured_hosts) when is_list(configured_hosts) do
    hosts =
      configured_hosts
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&(&1 == ""))
      |> Enum.uniq()

    case preferred_host do
      host when is_binary(host) and host != "" ->
        [host | Enum.reject(hosts, &(&1 == host))]

      _ when hosts == [] ->
        [nil]

      _ ->
        hosts
    end
  end

  defp worker_hosts_for_log(worker_hosts) do
    Enum.map(worker_hosts, &worker_host_for_log/1)
  end

  defp worker_host_for_log(nil), do: "local"
  defp worker_host_for_log(worker_host), do: worker_host

  defp normalize_issue_state(state_name) when is_binary(state_name) do
    state_name
    |> String.trim()
    |> String.downcase()
  end

  defp issue_context(%Issue{id: issue_id, identifier: identifier}) do
    "issue_id=#{issue_id} issue_identifier=#{identifier}"
  end
end
