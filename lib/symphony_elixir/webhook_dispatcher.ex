defmodule SymphonyElixir.WebhookDispatcher do
  @moduledoc """
  Dispatches Linear Agent webhook events to the execution layer.

  Handles `AgentSessionEvent` webhooks with actions `created` (new session
  from @mention or delegation) and `prompted` (user follow-up message).
  """

  require Logger

  alias SymphonyElixir.{AgentSession, Config, Orchestrator, Settings, Store, Workflow}
  alias SymphonyElixir.Linear.{AgentAPI, Client, Issue}

  @spec dispatch_created(map(), keyword()) :: :ok | {:error, term()}
  def dispatch_created(payload, opts \\ []) when is_map(payload) do
    with {:ok, issue_id} <- extract_issue_id(payload),
         {:ok, agent_session_id} <- extract_agent_session_id(payload) do
      Logger.info("Webhook dispatch_created issue_id=#{issue_id} agent_session_id=#{agent_session_id}")

      # Emit initial acknowledgment — must stay first side-effect after ID extraction
      emit_initial_thought(agent_session_id, opts)

      # Check if already claimed (e.g., Orchestrator already picked it up)
      case Store.claim_issue(issue_id, "webhook") do
        {:ok, :claimed} ->
          dispatch_new_session(issue_id, agent_session_id, payload)

        {:error, :already_claimed} ->
          Logger.info("Issue #{issue_id} already claimed, associating agent session")
          maybe_associate_session(issue_id, agent_session_id)
          :ok
      end
    else
      {:error, reason} ->
        Logger.warning("Failed to dispatch webhook created: #{inspect(reason)}")
        {:error, reason}
    end
  end

  @spec dispatch_prompted(map()) :: :ok | {:error, term()}
  def dispatch_prompted(payload) when is_map(payload) do
    case extract_signal(payload) do
      "stop" ->
        dispatch_stop(payload)

      _other ->
        dispatch_prompt_message(payload)
    end
  end

  defp dispatch_prompt_message(payload) do
    with {:ok, agent_session_id} <- extract_agent_session_id(payload),
         {:ok, message} <- extract_prompt_message(payload) do
      Logger.info("Webhook dispatch_prompted agent_session_id=#{agent_session_id}")

      # Find the issue_id for this agent session
      case find_issue_id_for_session(agent_session_id) do
        {:ok, issue_id} ->
          AgentSession.inject_prompt(issue_id, message)

          AgentAPI.create_activity(agent_session_id, %{
            type: "thought",
            body: "Received your message, will incorporate in the next step.",
            ephemeral: true
          })

          :ok

        {:error, reason} ->
          Logger.warning("No active session for agent_session_id=#{agent_session_id}: #{inspect(reason)}")
          {:error, reason}
      end
    else
      {:error, reason} ->
        Logger.warning("Failed to dispatch webhook prompted: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp dispatch_stop(payload) do
    case extract_agent_session_id(payload) do
      {:ok, agent_session_id} ->
        Logger.info("Webhook dispatch_stop agent_session_id=#{agent_session_id}")

        case find_issue_id_for_session(agent_session_id) do
          {:ok, issue_id} ->
            terminate_agent_for_issue(issue_id)
            :ok

          {:error, reason} ->
            Logger.warning("No active session for stop signal agent_session_id=#{agent_session_id}: #{inspect(reason)}")
            {:error, reason}
        end

      {:error, reason} ->
        Logger.warning("Failed to dispatch webhook stop: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp terminate_agent_for_issue(issue_id) do
    # Try orchestrator path first — it handles its own state cleanup
    case Orchestrator.stop_issue(issue_id) do
      :ok ->
        Logger.info("Stopped orchestrator-dispatched issue_id=#{issue_id}")

      {:error, :not_found} ->
        # Webhook-dispatched task — terminate directly via stored runner PID
        terminate_webhook_runner(issue_id)
    end
  end

  defp terminate_webhook_runner(issue_id) do
    runner_pid = AgentSession.get_runner_pid(issue_id)
    AgentSession.complete(issue_id, :stopped)
    kill_runner_task(issue_id, runner_pid)
    Store.release_issue_claim(issue_id)
  end

  defp kill_runner_task(issue_id, pid) when is_pid(pid) do
    case Task.Supervisor.terminate_child(SymphonyElixir.TaskSupervisor, pid) do
      :ok ->
        Logger.info("Terminated webhook runner task for issue_id=#{issue_id}")

      {:error, :not_found} ->
        Process.exit(pid, :shutdown)
        Logger.info("Sent shutdown to webhook runner process for issue_id=#{issue_id}")
    end
  end

  defp kill_runner_task(issue_id, _pid) do
    Logger.warning("No runner PID found for issue_id=#{issue_id}")
  end

  # -- Internal --

  defp dispatch_new_session(issue_id, agent_session_id, payload) do
    prompt_context = Map.get(payload, "promptContext", "")

    case fetch_issue(issue_id) do
      {:ok, issue} ->
        start_agent_session_and_runner(issue, agent_session_id, prompt_context)

      {:error, reason} ->
        Logger.error("Failed to fetch issue #{issue_id} for webhook dispatch: #{inspect(reason)}")
        Store.release_issue_claim(issue_id)
        {:error, reason}
    end
  end

  defp start_agent_session_and_runner(issue, agent_session_id, prompt_context) do
    case AgentSession.start_link(
           issue_id: issue.id,
           agent_session_id: agent_session_id,
           dispatch_source: :webhook
         ) do
      {:ok, _pid} ->
        spawn_agent_runner(issue, prompt_context)
        :ok

      {:error, {:already_started, _pid}} ->
        Logger.info("AgentSession already exists for issue #{issue.id}")
        :ok

      {:error, reason} ->
        Logger.error("Failed to start AgentSession: #{inspect(reason)}")
        Store.release_issue_claim(issue.id)
        {:error, reason}
    end
  end

  defp spawn_agent_runner(issue, prompt_context) do
    case Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
           try do
             resolve_and_set_project(issue)
             {workflow_name, config} = resolve_mention_workflow()

             Workflow.with_workflow(workflow_name, fn ->
               SymphonyElixir.AgentRunner.run(issue, nil,
                 max_turns: config.agent.max_turns,
                 prompt_context: prompt_context
               )
             end)
           rescue
             e ->
               Logger.error("Webhook-dispatched agent run failed for #{issue.id}: #{Exception.message(e)}")
           after
             Store.release_issue_claim(issue.id)

             if AgentSession.active?(issue.id) do
               AgentSession.complete(issue.id, :failed)
             end
           end
         end) do
      {:ok, pid} ->
        AgentSession.set_runner_pid(issue.id, pid)
        {:ok, pid}

      error ->
        error
    end
  end

  defp resolve_mention_workflow do
    mention_name = "MENTION"

    if mention_name in Workflow.workflow_names() do
      {mention_name, Config.settings!(mention_name)}
    else
      default_name = Workflow.default_workflow_name()
      {default_name, Config.settings!(default_name)}
    end
  end

  defp emit_initial_thought(agent_session_id, opts) do
    result =
      AgentAPI.create_activity(agent_session_id, %{
        type: "thought",
        body: "Starting session...",
        ephemeral: true
      })

    emit_first_activity_telemetry(opts[:received_at], agent_session_id)

    result
  end

  defp emit_first_activity_telemetry(nil, _agent_session_id), do: :ok

  defp emit_first_activity_telemetry(received_at, agent_session_id) do
    latency_ns = System.monotonic_time() - received_at
    latency_ms = System.convert_time_unit(latency_ns, :native, :millisecond)

    :telemetry.execute(
      [:symphony, :webhook, :first_activity_latency],
      %{duration: latency_ns},
      %{agent_session_id: agent_session_id}
    )

    Logger.info("Webhook first_activity_latency_ms=#{latency_ms} agent_session_id=#{agent_session_id}")
  end

  defp fetch_issue(issue_id) do
    case Client.fetch_issue_states_by_ids([issue_id]) do
      {:ok, [issue | _]} -> {:ok, issue}
      {:ok, []} -> {:error, :issue_not_found}
      {:error, reason} -> {:error, reason}
    end
  end

  defp maybe_associate_session(issue_id, agent_session_id) do
    # Use start_link as atomic guard — :already_started means a session exists,
    # preventing the race where a non-atomic active? + start_link could spawn duplicates.
    case AgentSession.start_link(
           issue_id: issue_id,
           agent_session_id: agent_session_id,
           dispatch_source: :webhook
         ) do
      {:ok, _pid} ->
        :ok

      {:error, {:already_started, _pid}} ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to associate session for issue_id=#{issue_id}: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp find_issue_id_for_session(agent_session_id) do
    # Check in-memory registry first via Store
    case Store.find_session_by_agent_session_id(agent_session_id) do
      %{issue_id: issue_id} when is_binary(issue_id) ->
        {:ok, issue_id}

      _ ->
        {:error, :session_not_found}
    end
  end

  defp resolve_and_set_project(%Issue{project_slug_id: slug_id})
       when is_binary(slug_id) and slug_id != "" do
    case Store.find_project_by_slug_id(slug_id) do
      %Store.Project{} = project ->
        Logger.info("Resolved project=#{project.name} for webhook issue slug_id=#{slug_id}")
        Settings.put_current_project(project)

      nil ->
        Logger.warning("No project found matching slug_id=#{slug_id}, falling back to first project")
        fallback_to_first_project()
    end
  end

  defp resolve_and_set_project(_issue) do
    Logger.warning("Issue has no project_slug_id, falling back to first project")
    fallback_to_first_project()
  end

  defp fallback_to_first_project do
    case Store.list_projects() do
      [%Store.Project{} = project | _] ->
        Settings.put_current_project(project)

      _ ->
        Logger.warning("No project found for webhook-dispatched run")
        :ok
    end
  end

  defp extract_issue_id(payload) do
    case get_in(payload, ["agentSession", "issueId"]) ||
           get_in(payload, ["data", "issueId"]) ||
           get_in(payload, ["issueId"]) do
      id when is_binary(id) -> {:ok, id}
      _ -> {:error, :missing_issue_id}
    end
  end

  defp extract_agent_session_id(payload) do
    case get_in(payload, ["agentSession", "id"]) ||
           get_in(payload, ["data", "id"]) ||
           get_in(payload, ["agentSessionId"]) do
      id when is_binary(id) -> {:ok, id}
      _ -> {:error, :missing_agent_session_id}
    end
  end

  defp extract_prompt_message(payload) do
    case get_in(payload, ["agentSession", "comment", "body"]) ||
           get_in(payload, ["data", "agentActivity", "body"]) ||
           get_in(payload, ["agentActivity", "body"]) do
      body when is_binary(body) -> {:ok, body}
      _ -> {:error, :missing_prompt_message}
    end
  end

  defp extract_signal(payload) do
    get_in(payload, ["agentSession", "signal"]) ||
      get_in(payload, ["data", "signal"]) ||
      get_in(payload, ["signal"])
  end
end
