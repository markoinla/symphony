defmodule SymphonyElixir.AgentRunner do
  @moduledoc """
  Executes a single Linear issue in its workspace with Codex.
  """

  require Logger
  alias SymphonyElixir.Codex.AppServer
  alias SymphonyElixir.Codex.DynamicTool
  alias SymphonyElixir.Config
  alias SymphonyElixir.Linear.Client
  alias SymphonyElixir.Linear.CommentWatcher
  alias SymphonyElixir.Linear.Issue
  alias SymphonyElixir.PromptBuilder
  alias SymphonyElixir.SessionLog
  alias SymphonyElixir.Tracker
  alias SymphonyElixir.Workspace

  @type worker_host :: String.t() | nil

  @spec run(map(), pid() | nil, keyword()) :: :ok | no_return()
  def run(issue, codex_update_recipient \\ nil, opts \\ []) do
    worker_hosts =
      candidate_worker_hosts(Keyword.get(opts, :worker_host), Config.settings!().worker.ssh_hosts)

    Logger.info("Starting agent run for #{issue_context(issue)} worker_hosts=#{inspect(worker_hosts_for_log(worker_hosts))}")

    case run_on_worker_hosts(issue, codex_update_recipient, opts, worker_hosts) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.error("Agent run failed for #{issue_context(issue)}: #{inspect(reason)}")
        raise RuntimeError, "Agent run failed for #{issue_context(issue)}: #{inspect(reason)}"
    end
  end

  defp run_on_worker_hosts(issue, codex_update_recipient, opts, [worker_host | rest]) do
    case run_on_worker_host(issue, codex_update_recipient, opts, worker_host) do
      :ok ->
        :ok

      {:error, reason} when rest != [] ->
        Logger.warning("Agent run failed for #{issue_context(issue)} worker_host=#{worker_host_for_log(worker_host)} reason=#{inspect(reason)}; trying next worker host")
        run_on_worker_hosts(issue, codex_update_recipient, opts, rest)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp run_on_worker_hosts(_issue, _codex_update_recipient, _opts, []), do: {:error, :no_worker_hosts_available}

  defp run_on_worker_host(issue, codex_update_recipient, opts, worker_host) do
    Logger.info("Starting worker attempt for #{issue_context(issue)} worker_host=#{worker_host_for_log(worker_host)}")

    case Workspace.create_for_issue(issue, worker_host) do
      {:ok, workspace} ->
        send_worker_runtime_info(codex_update_recipient, issue, worker_host, workspace)

        try do
          with :ok <- Workspace.run_before_run_hook(workspace, issue, worker_host) do
            run_codex_turns(workspace, issue, codex_update_recipient, opts, worker_host)
          end
        after
          Workspace.run_after_run_hook(workspace, issue, worker_host)
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp codex_message_handler(recipient, issue) do
    fn message ->
      send_codex_update(recipient, issue, message)
    end
  end

  defp codex_message_handler_with_log(recipient, %Issue{id: issue_id} = issue, session_id)
       when is_binary(issue_id) and is_binary(session_id) do
    fn message ->
      send_codex_update(recipient, issue, message)
      SessionLog.append(issue_id, session_id, message)
    end
  end

  defp codex_message_handler_with_log(recipient, issue, _session_id) do
    codex_message_handler(recipient, issue)
  end

  defp send_codex_update(recipient, %Issue{id: issue_id}, message)
       when is_binary(issue_id) and is_pid(recipient) do
    send(recipient, {:codex_worker_update, issue_id, message})
    :ok
  end

  defp send_codex_update(_recipient, _issue, _message), do: :ok

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

  defp run_codex_turns(workspace, issue, codex_update_recipient, opts, worker_host) do
    max_turns = Keyword.get(opts, :max_turns, Config.settings!().agent.max_turns)
    issue_state_fetcher = Keyword.get(opts, :issue_state_fetcher, &Tracker.fetch_issue_states_by_ids/1)
    linear_client = Keyword.get(opts, :linear_client, &Client.graphql/3)

    with {:ok, session} <- AppServer.start_session(workspace, worker_host: worker_host) do
      session_id = session[:session_id] || "session_#{System.unique_integer([:positive])}"
      start_session_log(issue, session_id)
      {:ok, comment_watcher} = Agent.start_link(fn -> CommentWatcher.new(issue.comments) end)

      try do
        do_run_codex_turns(
          session,
          workspace,
          issue,
          codex_update_recipient,
          opts,
          issue_state_fetcher,
          linear_client,
          1,
          max_turns,
          session_id,
          comment_watcher,
          []
        )
      after
        stop_session_log(issue, session_id)
        Agent.stop(comment_watcher)
        AppServer.stop_session(session)
      end
    end
  end

  defp start_session_log(%Issue{id: issue_id} = issue, session_id) when is_binary(issue_id) and is_binary(session_id) do
    case SessionLog.start_link(issue_id: issue_id, session_id: session_id, issue_identifier: issue.identifier, issue_title: issue.title) do
      {:ok, _pid} ->
        :ok

      {:error, {:already_started, _pid}} ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to start SessionLog for issue_id=#{issue_id} session_id=#{session_id}: #{inspect(reason)}")
        :ok
    end
  end

  defp start_session_log(_issue, _session_id), do: :ok

  defp stop_session_log(%Issue{id: issue_id}, session_id) when is_binary(issue_id) and is_binary(session_id) do
    SessionLog.stop(issue_id, session_id)
  end

  defp stop_session_log(_issue, _session_id), do: :ok

  # credo:disable-for-next-line
  defp do_run_codex_turns(
         app_session,
         workspace,
         issue,
         codex_update_recipient,
         opts,
         issue_state_fetcher,
         linear_client,
         turn_number,
         max_turns,
         session_id,
         comment_watcher,
         pending_comments
       ) do
    prompt = build_turn_prompt(issue, opts, turn_number, max_turns, pending_comments)
    tool_executor = dynamic_tool_executor(issue, issue_state_fetcher, linear_client, comment_watcher)

    with {:ok, turn_session} <-
           AppServer.run_turn(
             app_session,
             prompt,
             issue,
             on_message: codex_message_handler_with_log(codex_update_recipient, issue, session_id),
             tool_executor: tool_executor
           ) do
      Logger.info("Completed agent run for #{issue_context(issue)} session_id=#{turn_session[:session_id]} workspace=#{workspace} turn=#{turn_number}/#{max_turns}")

      case continue_with_issue?(issue, issue_state_fetcher, comment_watcher) do
        {:continue, refreshed_issue, new_comments} when turn_number < max_turns ->
          Logger.info("Continuing agent run for #{issue_context(refreshed_issue)} after normal turn completion turn=#{turn_number}/#{max_turns}")

          do_run_codex_turns(
            app_session,
            workspace,
            refreshed_issue,
            codex_update_recipient,
            opts,
            issue_state_fetcher,
            linear_client,
            turn_number + 1,
            max_turns,
            session_id,
            comment_watcher,
            new_comments
          )

        {:continue, refreshed_issue, _new_comments} ->
          Logger.info("Reached agent.max_turns for #{issue_context(refreshed_issue)} with issue still active; returning control to orchestrator")

          :ok

        {:done, _refreshed_issue, _new_comments} ->
          :ok

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defp build_turn_prompt(issue, opts, 1, _max_turns, _pending_comments), do: PromptBuilder.build_prompt(issue, opts)

  defp build_turn_prompt(_issue, _opts, turn_number, max_turns, pending_comments) do
    comments_section =
      case render_new_comment_section(pending_comments) do
        "" -> ""
        rendered -> "\n#{rendered}"
      end

    """
    Continuation guidance:

    - The previous Codex turn completed normally, but the Linear issue is still in an active state.
    - This is continuation turn ##{turn_number} of #{max_turns} for the current agent run.
    - Resume from the current workspace and workpad state instead of restarting from scratch.
    - The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
    - Treat new non-workpad Linear comments as fresh user input that may require action in this turn.
    - Use `linear_create_issue_comment` for issue replies and `linear_watch_comments` if you need another in-turn refresh.
    - Symphony does not inject new Linear comments into a turn after it has already started; mid-turn push remains deferred.
    - Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.
    #{comments_section}
    """
  end

  defp continue_with_issue?(%Issue{id: issue_id} = issue, issue_state_fetcher, comment_watcher)
       when is_binary(issue_id) do
    case issue_state_fetcher.([issue_id]) do
      {:ok, [%Issue{} = refreshed_issue | _]} ->
        new_comments = advance_comment_watcher(comment_watcher, refreshed_issue.comments)

        if active_issue_state?(refreshed_issue.state) and issue_still_matches_label_filter?(refreshed_issue) do
          {:continue, refreshed_issue, new_comments}
        else
          {:done, refreshed_issue, new_comments}
        end

      {:ok, []} ->
        {:done, issue, []}

      {:error, reason} ->
        {:error, {:issue_state_refresh_failed, reason}}
    end
  end

  defp continue_with_issue?(issue, _issue_state_fetcher, _comment_watcher), do: {:done, issue, []}

  defp advance_comment_watcher(comment_watcher, comments) when is_list(comments) do
    Agent.get_and_update(comment_watcher, fn watcher ->
      {next_watcher, new_comments} = CommentWatcher.advance(watcher, comments)
      {new_comments, next_watcher}
    end)
  end

  defp dynamic_tool_executor(issue, issue_state_fetcher, linear_client, comment_watcher) do
    fn tool, arguments ->
      result =
        DynamicTool.execute(
          tool,
          arguments,
          issue_id: issue.id,
          issue_state_fetcher: issue_state_fetcher,
          linear_client: linear_client,
          ignored_comment_ids: Agent.get(comment_watcher, &CommentWatcher.ignored_comment_ids/1)
        )

      maybe_track_created_comment(comment_watcher, tool, result)
      result
    end
  end

  defp maybe_track_created_comment(comment_watcher, "linear_create_issue_comment", %{"success" => true, "output" => output})
       when is_pid(comment_watcher) and is_binary(output) do
    with {:ok, %{"commentId" => comment_id}} <- Jason.decode(output) do
      Agent.update(comment_watcher, &CommentWatcher.track_created_comment(&1, comment_id))
    end
  end

  defp maybe_track_created_comment(_comment_watcher, _tool, _result), do: :ok

  defp render_new_comment_section([]), do: ""

  defp render_new_comment_section(comments) when is_list(comments) do
    rendered_comments =
      Enum.map_join(comments, "\n\n", fn comment ->
        author = comment[:author] || "Unknown author"
        created_at = comment[:created_at] || "unknown time"
        body = comment[:body] || ""

        """
        ---
        **#{author}** (#{created_at}):
        #{body}
        """
      end)

    """
    New Linear comments since last turn:

    #{rendered_comments}
    """
  end

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
