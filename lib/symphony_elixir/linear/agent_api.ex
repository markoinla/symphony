defmodule SymphonyElixir.Linear.AgentAPI do
  @moduledoc """
  Linear Agent API client for agent sessions, activities, and plans.

  Uses the OAuth app token (LINEAR_OAUTH_TOKEN) instead of the personal API key,
  so that activities are attributed to the agent application.
  """

  require Logger

  alias SymphonyElixir.Config
  alias SymphonyElixir.Linear.OAuth

  @create_session_mutation """
  mutation SymphonyCreateAgentSession($input: AgentSessionCreateOnIssue!) {
    agentSessionCreateOnIssue(input: $input) {
      success
      agentSession {
        id
      }
    }
  }
  """

  @create_activity_mutation """
  mutation SymphonyCreateAgentActivity($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) {
      success
    }
  }
  """

  @update_session_mutation """
  mutation SymphonyUpdateAgentSession($id: String!, $input: AgentSessionUpdateInput!) {
    agentSessionUpdate(id: $id, input: $input) {
      success
    }
  }
  """

  @spec create_session_on_issue(String.t()) :: {:ok, String.t()} | {:error, term()}
  def create_session_on_issue(issue_id) when is_binary(issue_id) do
    with {:ok, response} <-
           agent_graphql(@create_session_mutation, %{input: %{issueId: issue_id}}),
         true <- get_in(response, ["data", "agentSessionCreateOnIssue", "success"]) == true do
      {:ok, get_in(response, ["data", "agentSessionCreateOnIssue", "agentSession", "id"])}
    else
      false -> {:error, :session_create_failed}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :session_create_failed}
    end
  end

  @spec create_activity(String.t(), map()) :: :ok | {:error, term()}
  def create_activity(agent_session_id, content)
      when is_binary(agent_session_id) and is_map(content) do
    case agent_graphql(@create_activity_mutation, %{
           input: %{
             agentSessionId: agent_session_id,
             content: content
           }
         }) do
      {:ok, response} ->
        if get_in(response, ["data", "agentActivityCreate", "success"]) == true,
          do: :ok,
          else: {:error, :activity_create_failed}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec complete_session(String.t(), :completed | :failed) :: :ok | {:error, term()}
  def complete_session(agent_session_id, outcome)
      when is_binary(agent_session_id) and outcome in [:completed, :failed] do
    body =
      case outcome do
        :completed -> "Agent session completed successfully."
        :failed -> "Agent session ended with errors."
      end

    content = %{type: "response", body: body}

    case agent_graphql(@create_activity_mutation, %{
           input: %{
             agentSessionId: agent_session_id,
             content: content,
             signal: "stop"
           }
         }) do
      {:ok, response} ->
        if get_in(response, ["data", "agentActivityCreate", "success"]) == true,
          do: :ok,
          else: {:error, :session_complete_failed}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec update_session(String.t(), keyword()) :: :ok | {:error, term()}
  def update_session(agent_session_id, opts \\ [])
      when is_binary(agent_session_id) and is_list(opts) do
    input =
      %{}
      |> maybe_put(:plan, Keyword.get(opts, :plan))
      |> maybe_put(:addedExternalUrls, Keyword.get(opts, :added_external_urls))
      |> maybe_put(:removedExternalUrls, Keyword.get(opts, :removed_external_urls))

    with {:ok, response} <-
           agent_graphql(@update_session_mutation, %{
             id: agent_session_id,
             input: input
           }),
         true <- get_in(response, ["data", "agentSessionUpdate", "success"]) == true do
      :ok
    else
      false -> {:error, :session_update_failed}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :session_update_failed}
    end
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp agent_graphql(query, variables) do
    case oauth_token() do
      nil ->
        Logger.warning("LINEAR_OAUTH_TOKEN not set, agent API calls will fail")
        {:error, :missing_oauth_token}

      token ->
        payload = %{"query" => query, "variables" => variables}

        headers = [
          {"Authorization", "Bearer #{token}"},
          {"Content-Type", "application/json"}
        ]

        endpoint = Config.settings!().tracker.endpoint

        case Req.post(endpoint, json: payload, headers: headers, receive_timeout: 30_000) do
          {:ok, %{status: 200, body: body}} ->
            {:ok, body}

          {:ok, response} ->
            Logger.error("Linear Agent API request failed status=#{response.status} body=#{inspect(response.body)}")

            {:error, {:linear_api_status, response.status}}

          {:error, reason} ->
            Logger.error("Linear Agent API request failed: #{inspect(reason)}")
            {:error, {:linear_api_request, reason}}
        end
    end
  end

  defp oauth_token do
    OAuth.current_access_token()
  end
end
