defmodule SymphonyElixir.Linear.Adapter do
  @moduledoc """
  Linear-backed tracker adapter.
  """

  @behaviour SymphonyElixir.Tracker

  alias SymphonyElixir.Linear.Client

  @create_comment_mutation """
  mutation SymphonyCreateComment($issueId: String!, $body: String!) {
    commentCreate(input: {issueId: $issueId, body: $body}) {
      success
      comment {
        id
      }
    }
  }
  """

  @update_comment_mutation """
  mutation SymphonyUpdateComment($commentId: String!, $body: String!) {
    commentUpdate(id: $commentId, input: {body: $body}) {
      success
    }
  }
  """

  @update_state_mutation """
  mutation SymphonyUpdateIssueState($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: {stateId: $stateId}) {
      success
    }
  }
  """

  @state_lookup_query """
  query SymphonyResolveStateId($issueId: String!, $stateName: String!) {
    issue(id: $issueId) {
      team {
        states(filter: {name: {eq: $stateName}}, first: 1) {
          nodes {
            id
          }
        }
      }
    }
  }
  """

  @add_label_mutation """
  mutation SymphonyAddIssueLabel($issueId: String!, $labelIds: [String!]!) {
    issueUpdate(id: $issueId, input: {addedLabelIds: $labelIds}) {
      success
    }
  }
  """

  @label_lookup_query """
  query SymphonyResolveIssueLabelId($issueId: String!, $labelName: String!) {
    issue(id: $issueId) {
      team {
        labels(filter: {name: {eq: $labelName}}, first: 1) {
          nodes {
            id
          }
        }
      }
    }
  }
  """

  @issue_attachments_query """
  query SymphonyIssueAttachments($issueId: String!) {
    issue(id: $issueId) {
      attachments(first: 50) {
        nodes {
          url
        }
      }
    }
  }
  """

  @create_attachment_mutation """
  mutation SymphonyCreateAttachment($issueId: String!, $url: String!, $title: String!) {
    attachmentCreate(input: {issueId: $issueId, url: $url, title: $title}) {
      success
    }
  }
  """

  @spec fetch_candidate_issues() :: {:ok, [term()]} | {:error, term()}
  def fetch_candidate_issues, do: client_module().fetch_candidate_issues()

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [term()]} | {:error, term()}
  def fetch_issues_by_states(states), do: client_module().fetch_issues_by_states(states)

  @spec fetch_issue_states_by_ids([String.t()]) :: {:ok, [term()]} | {:error, term()}
  def fetch_issue_states_by_ids(issue_ids), do: client_module().fetch_issue_states_by_ids(issue_ids)

  @spec fetch_issue_comments(String.t()) :: {:ok, [term()]} | {:error, term()}
  def fetch_issue_comments(issue_id) when is_binary(issue_id) do
    client_module().fetch_issue_comments(issue_id)
  end

  @spec create_comment(String.t(), String.t()) :: {:ok, String.t() | nil} | {:error, term()}
  def create_comment(issue_id, body) when is_binary(issue_id) and is_binary(body) do
    with {:ok, response} <- client_module().graphql(@create_comment_mutation, %{issueId: issue_id, body: body}),
         true <- get_in(response, ["data", "commentCreate", "success"]) == true do
      {:ok, get_in(response, ["data", "commentCreate", "comment", "id"])}
    else
      false -> {:error, :comment_create_failed}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :comment_create_failed}
    end
  end

  @spec update_comment(String.t(), String.t()) :: :ok | {:error, term()}
  def update_comment(comment_id, body) when is_binary(comment_id) and is_binary(body) do
    with {:ok, response} <-
           client_module().graphql(@update_comment_mutation, %{commentId: comment_id, body: body}),
         true <- get_in(response, ["data", "commentUpdate", "success"]) == true do
      :ok
    else
      false -> {:error, :comment_update_failed}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :comment_update_failed}
    end
  end

  @spec update_issue_state(String.t(), String.t()) :: :ok | {:error, term()}
  def update_issue_state(issue_id, state_name)
      when is_binary(issue_id) and is_binary(state_name) do
    with {:ok, state_id} <- resolve_state_id(issue_id, state_name),
         {:ok, response} <-
           client_module().graphql(@update_state_mutation, %{issueId: issue_id, stateId: state_id}),
         true <- get_in(response, ["data", "issueUpdate", "success"]) == true do
      :ok
    else
      false -> {:error, :issue_update_failed}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :issue_update_failed}
    end
  end

  @spec add_issue_label(String.t(), String.t()) :: :ok | {:error, term()}
  def add_issue_label(issue_id, label_name)
      when is_binary(issue_id) and is_binary(label_name) do
    with {:ok, label_id} <- resolve_label_id(issue_id, label_name),
         {:ok, response} <-
           client_module().graphql(@add_label_mutation, %{issueId: issue_id, labelIds: [label_id]}),
         true <- get_in(response, ["data", "issueUpdate", "success"]) == true do
      :ok
    else
      false -> {:error, :issue_update_failed}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :issue_update_failed}
    end
  end

  @spec ensure_issue_resource_link(String.t(), String.t(), String.t()) :: :ok | {:error, term()}
  def ensure_issue_resource_link(issue_id, url, title)
      when is_binary(issue_id) and is_binary(url) and is_binary(title) do
    with {:ok, attachment_urls} <- fetch_attachment_urls(issue_id) do
      if url in attachment_urls do
        :ok
      else
        create_attachment(issue_id, url, title)
      end
    end
  end

  defp client_module do
    Application.get_env(:symphony_elixir, :linear_client_module, Client)
  end

  defp fetch_attachment_urls(issue_id) do
    with {:ok, response} <-
           client_module().graphql(@issue_attachments_query, %{issueId: issue_id}),
         nodes when is_list(nodes) <-
           get_in(response, ["data", "issue", "attachments", "nodes"]) do
      {:ok,
       nodes
       |> Enum.map(&Map.get(&1, "url"))
       |> Enum.filter(&is_binary/1)}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :attachment_lookup_failed}
    end
  end

  defp create_attachment(issue_id, url, title) do
    with {:ok, response} <-
           client_module().graphql(@create_attachment_mutation, %{issueId: issue_id, url: url, title: title}),
         true <- get_in(response, ["data", "attachmentCreate", "success"]) == true do
      :ok
    else
      false -> {:error, :attachment_create_failed}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :attachment_create_failed}
    end
  end

  defp resolve_state_id(issue_id, state_name) do
    with {:ok, response} <-
           client_module().graphql(@state_lookup_query, %{issueId: issue_id, stateName: state_name}),
         state_id when is_binary(state_id) <-
           get_in(response, ["data", "issue", "team", "states", "nodes", Access.at(0), "id"]) do
      {:ok, state_id}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :state_not_found}
    end
  end

  defp resolve_label_id(issue_id, label_name) do
    with {:ok, response} <-
           client_module().graphql(@label_lookup_query, %{issueId: issue_id, labelName: label_name}),
         label_id when is_binary(label_id) <-
           get_in(response, ["data", "issue", "team", "labels", "nodes", Access.at(0), "id"]) do
      {:ok, label_id}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :label_not_found}
    end
  end
end
