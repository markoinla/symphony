defmodule SymphonyElixir.WebhookDispatcher do
  @moduledoc """
  Dispatches Linear Agent webhook events to the execution layer.

  Handles `AgentSessionEvent` webhooks with actions `created` (new session
  from @mention or delegation) and `prompted` (user follow-up message).
  """

  require Logger

  alias SymphonyElixir.{AgentSession, Config, Settings, Store, Workflow}
  alias SymphonyElixir.Linear.{AgentAPI, Client}

  @spec dispatch_created(map()) :: :ok | {:error, term()}
  def dispatch_created(payload) when is_map(payload) do
    with {:ok, issue_id} <- extract_issue_id(payload),
         {:ok, agent_session_id} <- extract_agent_session_id(payload) do
      Logger.info("Webhook dispatch_created issue_id=#{issue_id} agent_session_id=#{agent_session_id}")

      # Emit initial acknowledgment
      emit_initial_thought(agent_session_id)

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
    Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
      try do
        resolve_and_set_project()
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
        AgentSession.complete(issue.id, :failed)
      end
    end)
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

  defp emit_initial_thought(agent_session_id) do
    AgentAPI.create_activity(agent_session_id, %{
      type: "thought",
      body: "Starting session...",
      ephemeral: true
    })
  end

  defp fetch_issue(issue_id) do
    case Client.fetch_issue_states_by_ids([issue_id]) do
      {:ok, [issue | _]} -> {:ok, issue}
      {:ok, []} -> {:error, :issue_not_found}
      {:error, reason} -> {:error, reason}
    end
  end

  defp maybe_associate_session(issue_id, agent_session_id) do
    # If there's already an AgentSession for this issue, update it;
    # otherwise start a new one that will track the existing run
    unless AgentSession.active?(issue_id) do
      AgentSession.start_link(
        issue_id: issue_id,
        agent_session_id: agent_session_id,
        dispatch_source: :webhook
      )
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

  defp resolve_and_set_project do
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
end
