defmodule SymphonyElixir.Linear.AgentAPI do
  @moduledoc """
  Linear Agent API client for agent sessions, activities, and plans.
  """

  alias SymphonyElixir.Linear.Client

  @create_session_mutation """
  mutation SymphonyCreateAgentSession($issueId: String!) {
    agentSessionCreateOnIssue(issueId: $issueId) {
      success
      agentSession {
        id
      }
    }
  }
  """

  @create_activity_mutation """
  mutation SymphonyCreateAgentActivity($agentSessionId: String!, $content: JSONObject!) {
    createAgentActivity(agentSessionId: $agentSessionId, content: $content) {
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
           client_module().graphql(@create_session_mutation, %{issueId: issue_id}),
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
    with {:ok, response} <-
           client_module().graphql(@create_activity_mutation, %{
             agentSessionId: agent_session_id,
             content: content
           }),
         true <- get_in(response, ["data", "createAgentActivity", "success"]) == true do
      :ok
    else
      false -> {:error, :activity_create_failed}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :activity_create_failed}
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
           client_module().graphql(@update_session_mutation, %{
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

  defp client_module do
    Application.get_env(:symphony_elixir, :linear_client_module, Client)
  end
end
