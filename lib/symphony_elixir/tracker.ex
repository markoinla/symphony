defmodule SymphonyElixir.Tracker do
  @moduledoc """
  Adapter boundary for issue tracker reads and writes.
  """

  alias SymphonyElixir.{Config, Workflow}
  alias SymphonyElixir.Linear.Comment

  @callback fetch_candidate_issues() :: {:ok, [term()]} | {:error, term()}
  @callback fetch_issues_by_states([String.t()]) :: {:ok, [term()]} | {:error, term()}
  @callback fetch_issue_states_by_ids([String.t()]) :: {:ok, [term()]} | {:error, term()}
  @callback fetch_issue_comments(String.t()) :: {:ok, [Comment.t()]} | {:error, term()}
  @callback create_comment(String.t(), String.t()) :: {:ok, String.t() | nil} | {:error, term()}
  @callback update_comment(String.t(), String.t()) :: :ok | {:error, term()}
  @callback update_issue_state(String.t(), String.t()) :: :ok | {:error, term()}
  @callback add_issue_label(String.t(), String.t()) :: :ok | {:error, term()}
  @callback ensure_issue_resource_link(String.t(), String.t(), String.t()) :: :ok | {:error, term()}

  @spec fetch_candidate_issues() :: {:ok, [term()]} | {:error, term()}
  def fetch_candidate_issues do
    fetch_candidate_issues(Workflow.current_workflow_name())
  end

  @spec fetch_candidate_issues(String.t()) :: {:ok, [term()]} | {:error, term()}
  def fetch_candidate_issues(workflow_name) when is_binary(workflow_name) do
    Workflow.with_workflow(workflow_name, fn ->
      adapter().fetch_candidate_issues()
    end)
  end

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [term()]} | {:error, term()}
  def fetch_issues_by_states(states) do
    fetch_issues_by_states(states, Workflow.current_workflow_name())
  end

  @spec fetch_issues_by_states([String.t()], String.t()) :: {:ok, [term()]} | {:error, term()}
  def fetch_issues_by_states(states, workflow_name) when is_list(states) and is_binary(workflow_name) do
    Workflow.with_workflow(workflow_name, fn ->
      adapter().fetch_issues_by_states(states)
    end)
  end

  @spec fetch_issue_states_by_ids([String.t()]) :: {:ok, [term()]} | {:error, term()}
  def fetch_issue_states_by_ids(issue_ids) do
    fetch_issue_states_by_ids(issue_ids, Workflow.current_workflow_name())
  end

  @spec fetch_issue_states_by_ids([String.t()], String.t()) :: {:ok, [term()]} | {:error, term()}
  def fetch_issue_states_by_ids(issue_ids, workflow_name)
      when is_list(issue_ids) and is_binary(workflow_name) do
    Workflow.with_workflow(workflow_name, fn ->
      adapter().fetch_issue_states_by_ids(issue_ids)
    end)
  end

  @spec fetch_issue_comments(String.t()) :: {:ok, [Comment.t()]} | {:error, term()}
  def fetch_issue_comments(issue_id) when is_binary(issue_id) do
    adapter().fetch_issue_comments(issue_id)
  end

  @spec create_comment(String.t(), String.t()) :: {:ok, String.t() | nil} | {:error, term()}
  def create_comment(issue_id, body) do
    adapter().create_comment(issue_id, body)
  end

  @spec update_comment(String.t(), String.t()) :: :ok | {:error, term()}
  def update_comment(comment_id, body) do
    adapter().update_comment(comment_id, body)
  end

  @spec update_issue_state(String.t(), String.t()) :: :ok | {:error, term()}
  def update_issue_state(issue_id, state_name) do
    adapter().update_issue_state(issue_id, state_name)
  end

  @spec add_issue_label(String.t(), String.t()) :: :ok | {:error, term()}
  def add_issue_label(issue_id, label_name) do
    adapter().add_issue_label(issue_id, label_name)
  end

  @spec ensure_issue_resource_link(String.t(), String.t(), String.t()) :: :ok | {:error, term()}
  def ensure_issue_resource_link(issue_id, url, title) do
    adapter().ensure_issue_resource_link(issue_id, url, title)
  end

  @spec adapter() :: module()
  def adapter do
    do_adapter()
  end

  @spec adapter(String.t()) :: module()
  def adapter(_workflow_name) do
    do_adapter()
  end

  defp do_adapter do
    case Config.settings!().tracker.kind do
      "memory" -> SymphonyElixir.Tracker.Memory
      _ -> SymphonyElixir.Linear.Adapter
    end
  end
end
