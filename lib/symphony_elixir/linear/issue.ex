defmodule SymphonyElixir.Linear.Issue do
  @moduledoc """
  Normalized Linear issue representation used by the orchestrator.
  """

  alias SymphonyElixir.Linear.Comment

  defstruct [
    :id,
    :identifier,
    :title,
    :description,
    :priority,
    :state,
    :branch_name,
    :url,
    :assignee_id,
    live_workpad_comment_id: nil,
    workpad_comment_count: 0,
    blocked_by: [],
    parent_issue: nil,
    child_issues: [],
    labels: [],
    comments: [],
    assigned_to_worker: true,
    project_slug_id: nil,
    created_at: nil,
    updated_at: nil
  ]

  @type comment :: Comment.t()

  @type issue_ref :: %{
          id: String.t(),
          identifier: String.t() | nil,
          title: String.t() | nil,
          state: String.t() | nil
        }

  @type t :: %__MODULE__{
          id: String.t() | nil,
          identifier: String.t() | nil,
          title: String.t() | nil,
          description: String.t() | nil,
          priority: integer() | nil,
          state: String.t() | nil,
          branch_name: String.t() | nil,
          url: String.t() | nil,
          assignee_id: String.t() | nil,
          live_workpad_comment_id: String.t() | nil,
          workpad_comment_count: non_neg_integer(),
          blocked_by: [issue_ref()],
          parent_issue: issue_ref() | nil,
          child_issues: [issue_ref()],
          labels: [String.t()],
          comments: [comment()],
          assigned_to_worker: boolean(),
          project_slug_id: String.t() | nil,
          created_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @spec label_names(t()) :: [String.t()]
  def label_names(%__MODULE__{labels: labels}) do
    labels
  end

  @doc """
  Returns true if the issue carries any of the given label names.

  Both the issue's labels and the provided names are downcased for comparison.
  """
  @spec has_any_label?(t(), [String.t()]) :: boolean()
  def has_any_label?(%__MODULE__{labels: labels}, skip_labels)
      when is_list(labels) and is_list(skip_labels) do
    case skip_labels do
      [] ->
        false

      _ ->
        normalized = MapSet.new(skip_labels, &String.downcase(String.trim(&1)))
        Enum.any?(labels, &(String.downcase(String.trim(&1)) in normalized))
    end
  end

  def has_any_label?(_, _), do: false
end
