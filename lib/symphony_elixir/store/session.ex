defmodule SymphonyElixir.Store.Session do
  @moduledoc """
  Ecto schema for persisted agent sessions.
  """

  use Ecto.Schema
  import Ecto.Changeset

  schema "sessions" do
    field(:issue_id, :string)
    field(:issue_identifier, :string)
    field(:issue_title, :string)
    field(:session_id, :string)
    field(:status, :string, default: "running")
    field(:started_at, :utc_datetime)
    field(:ended_at, :utc_datetime)
    field(:turn_count, :integer, default: 0)
    field(:input_tokens, :integer, default: 0)
    field(:output_tokens, :integer, default: 0)
    field(:total_tokens, :integer, default: 0)
    field(:worker_host, :string)
    field(:workspace_path, :string)
    field(:error, :string)
    field(:project_id, :integer)
    field(:agent_session_id, :string)
    field(:dispatch_source, :string, default: "orchestrator")

    belongs_to(:project, SymphonyElixir.Store.Project, define_field: false)
    has_many(:messages, SymphonyElixir.Store.Message)
  end

  @required_fields ~w(issue_id session_id status started_at)a
  @optional_fields ~w(issue_identifier issue_title ended_at turn_count input_tokens output_tokens total_tokens worker_host workspace_path error project_id agent_session_id dispatch_source)a

  @spec changeset(%__MODULE__{} | Ecto.Changeset.t(), map()) :: Ecto.Changeset.t()
  def changeset(session, attrs) do
    session
    |> cast(attrs, @required_fields ++ @optional_fields)
    |> validate_required(@required_fields)
    |> validate_inclusion(:status, ~w(running completed failed cancelled stopped))
  end
end
