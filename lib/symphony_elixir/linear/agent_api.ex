defmodule SymphonyElixir.Linear.AgentAPI do
  @moduledoc """
  Linear Agent API client for agent session and activity management.

  Follows the same `client_module()` indirection pattern as `Linear.Adapter`
  to allow test mocking via application config.
  """

  alias SymphonyElixir.Linear.Client

  @create_session_mutation """
  mutation SymphonyAgentCreateSession($issueId: String!) {
    agentSessionCreateOnIssue(issueId: $issueId) {
      success
      agentSession {
        id
      }
    }
  }
  """

  @create_activity_mutation """
  mutation SymphonyAgentCreateActivity($sessionId: String!, $content: String!) {
    createAgentActivity(input: {agentSessionId: $sessionId, content: $content}) {
      success
    }
  }
  """

  @update_session_mutation """
  mutation SymphonyAgentUpdateSession($sessionId: String!, $plan: String, $externalUrls: [String!]) {
    agentSessionUpdate(id: $sessionId, input: {plan: $plan, externalUrls: $externalUrls}) {
      success
    }
  }
  """

  @type activity_content ::
          %{type: :thought, body: String.t()}
          | %{type: :thought, body: String.t(), ephemeral: boolean()}
          | %{type: :action, action: String.t(), parameter: String.t()}
          | %{type: :action, action: String.t(), parameter: String.t(), result: String.t()}
          | %{type: :response, body: String.t()}
          | %{type: :error, body: String.t()}
          | %{type: :elicitation, body: String.t()}

  @doc """
  Creates a new agent session on the given Linear issue.

  Returns `{:ok, agent_session_id}` on success.
  """
  @spec create_session_on_issue(String.t()) :: {:ok, String.t()} | {:error, term()}
  def create_session_on_issue(issue_id) when is_binary(issue_id) do
    with {:ok, response} <-
           client_module().graphql(@create_session_mutation, %{issueId: issue_id}),
         true <-
           get_in(response, ["data", "agentSessionCreateOnIssue", "success"]) == true,
         session_id when is_binary(session_id) <-
           get_in(response, ["data", "agentSessionCreateOnIssue", "agentSession", "id"]) do
      {:ok, session_id}
    else
      false -> {:error, :agent_session_create_failed}
      nil -> {:error, :agent_session_create_failed}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :agent_session_create_failed}
    end
  end

  @doc """
  Creates an agent activity entry on the given agent session.

  The `content` map must include a `:type` key (one of `:thought`, `:action`,
  `:response`, `:error`, `:elicitation`) and the appropriate fields for that type.
  """
  @spec create_activity(String.t(), activity_content()) :: :ok | {:error, term()}
  def create_activity(agent_session_id, content)
      when is_binary(agent_session_id) and is_map(content) do
    encoded_content = encode_activity_content(content)

    with {:ok, response} <-
           client_module().graphql(@create_activity_mutation, %{
             sessionId: agent_session_id,
             content: encoded_content
           }),
         true <- get_in(response, ["data", "createAgentActivity", "success"]) == true do
      :ok
    else
      false -> {:error, :agent_activity_create_failed}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :agent_activity_create_failed}
    end
  end

  @doc """
  Updates an existing agent session with optional plan and external URLs.

  Supported options:
  - `:plan` — plan text for the session
  - `:external_urls` — list of external URL strings
  """
  @spec update_session(String.t(), keyword()) :: :ok | {:error, term()}
  def update_session(agent_session_id, opts \\ [])
      when is_binary(agent_session_id) and is_list(opts) do
    variables =
      %{sessionId: agent_session_id}
      |> maybe_put(:plan, Keyword.get(opts, :plan))
      |> maybe_put(:externalUrls, Keyword.get(opts, :external_urls))

    with {:ok, response} <-
           client_module().graphql(@update_session_mutation, variables),
         true <- get_in(response, ["data", "agentSessionUpdate", "success"]) == true do
      :ok
    else
      false -> {:error, :agent_session_update_failed}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :agent_session_update_failed}
    end
  end

  defp client_module do
    Application.get_env(:symphony_elixir, :linear_client_module, Client)
  end

  defp encode_activity_content(content) when is_map(content) do
    content
    |> Enum.reduce(%{}, fn {key, value}, acc ->
      Map.put(acc, to_string(key), value)
    end)
    |> Jason.encode!()
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
