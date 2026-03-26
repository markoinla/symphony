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
      session_id = get_in(response, ["data", "agentSessionCreateOnIssue", "agentSession", "id"])
      Logger.info("Created Linear agent session", issue_id: issue_id, agent_session_id: session_id)
      {:ok, session_id}
    else
      false ->
        Logger.warning("Linear agent session create returned success=false", issue_id: issue_id)
        {:error, :session_create_failed}

      {:error, reason} ->
        {:error, reason}

      other ->
        Logger.warning("Linear agent session create unexpected response: #{inspect(other)}",
          issue_id: issue_id
        )

        {:error, :session_create_failed}
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

  @spec complete_session(String.t(), :completed | :failed | :stopped) :: :ok | {:error, term()}
  def complete_session(agent_session_id, outcome)
      when is_binary(agent_session_id) and outcome in [:completed, :failed, :stopped] do
    # Successful completions don't need a final message — Linear auto-transitions
    # the session to "complete" after inactivity.
    case outcome do
      :completed ->
        :ok

      :failed ->
        create_activity(agent_session_id, %{type: "error", body: "Agent session ended with errors."})

      :stopped ->
        create_activity(agent_session_id, %{type: "response", body: "Agent session stopped by user."})
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

  @rate_limit_max_retries 3
  @rate_limit_base_delay_ms 2_000

  defp agent_graphql(query, variables) do
    case oauth_token() do
      nil ->
        Logger.warning("LINEAR_OAUTH_TOKEN not set, agent API calls will fail")
        {:error, :missing_oauth_token}

      token ->
        agent_graphql_with_retry(query, variables, token, 0)
    end
  end

  defp agent_graphql_with_retry(query, variables, token, attempt) do
    payload = %{"query" => query, "variables" => variables}

    headers = [
      {"Authorization", "Bearer #{token}"},
      {"Content-Type", "application/json"}
    ]

    endpoint = Config.settings!().tracker.endpoint

    case Req.post(endpoint, json: payload, headers: headers, receive_timeout: 30_000) do
      {:ok, %{status: 200, body: %{"errors" => [_ | _] = errors} = body}} ->
        messages = Enum.map_join(errors, "; ", &Map.get(&1, "message", "unknown"))
        Logger.warning("Linear Agent API GraphQL errors: #{messages}")
        {:ok, body}

      {:ok, %{status: 200, body: body}} ->
        {:ok, body}

      {:ok, %{status: 400, body: body} = response} when is_map(body) ->
        if rate_limited_response?(body) and attempt < @rate_limit_max_retries do
          delay = @rate_limit_base_delay_ms * Integer.pow(2, attempt)

          Logger.warning("Linear Agent API rate limited, retrying in #{delay}ms (attempt #{attempt + 1}/#{@rate_limit_max_retries})")

          Process.sleep(delay)
          agent_graphql_with_retry(query, variables, token, attempt + 1)
        else
          Logger.error("Linear Agent API request failed status=400 body=#{inspect(response.body)}")
          {:error, {:linear_api_status, 400}}
        end

      {:ok, response} ->
        Logger.error("Linear Agent API request failed status=#{response.status} body=#{inspect(response.body)}")
        {:error, {:linear_api_status, response.status}}

      {:error, reason} ->
        Logger.error("Linear Agent API request failed: #{inspect(reason)}")
        {:error, {:linear_api_request, reason}}
    end
  end

  defp rate_limited_response?(%{"errors" => errors}) when is_list(errors) do
    Enum.any?(errors, fn
      %{"extensions" => %{"code" => "RATELIMITED"}} -> true
      _ -> false
    end)
  end

  defp rate_limited_response?(_body), do: false

  defp oauth_token do
    OAuth.current_access_token()
  end
end
