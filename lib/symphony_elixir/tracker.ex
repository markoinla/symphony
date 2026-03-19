defmodule SymphonyElixir.Tracker do
  @moduledoc """
  Adapter boundary for issue tracker reads and writes.
  """

  alias SymphonyElixir.{Config, Workflow}

  @callback fetch_candidate_issues() :: {:ok, [term()]} | {:error, term()}
  @callback fetch_issues_by_states([String.t()]) :: {:ok, [term()]} | {:error, term()}
  @callback fetch_issue_states_by_ids([String.t()]) :: {:ok, [term()]} | {:error, term()}
  @callback create_comment(String.t(), String.t()) :: :ok | {:error, term()}
  @callback update_issue_state(String.t(), String.t()) :: :ok | {:error, term()}

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

  @spec create_comment(String.t(), String.t()) :: :ok | {:error, term()}
  def create_comment(issue_id, body) do
    adapter().create_comment(issue_id, body)
  end

  @spec update_issue_state(String.t(), String.t()) :: :ok | {:error, term()}
  def update_issue_state(issue_id, state_name) do
    adapter().update_issue_state(issue_id, state_name)
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
