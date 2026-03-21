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
    labels: [],
    comments: [],
    assigned_to_worker: true,
    created_at: nil,
    updated_at: nil
  ]

  @type comment :: Comment.t()

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
          labels: [String.t()],
          comments: [comment()],
          assigned_to_worker: boolean(),
          created_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @spec label_names(t()) :: [String.t()]
  def label_names(%__MODULE__{labels: labels}) do
    labels
  end
end
