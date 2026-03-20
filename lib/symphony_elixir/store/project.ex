defmodule SymphonyElixir.Store.Project do
  @moduledoc """
  Ecto schema for project entities linking a Linear project to a GitHub repo.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @type t :: %__MODULE__{
          id: integer() | nil,
          name: String.t() | nil,
          linear_project_slug: String.t() | nil,
          linear_organization_slug: String.t() | nil,
          linear_filter_by: String.t() | nil,
          linear_label_name: String.t() | nil,
          github_repo: String.t() | nil,
          workspace_root: String.t() | nil,
          created_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "projects" do
    field(:name, :string)
    field(:linear_project_slug, :string)
    field(:linear_organization_slug, :string)
    field(:linear_filter_by, :string, default: "project")
    field(:linear_label_name, :string)
    field(:github_repo, :string)
    field(:workspace_root, :string)
    field(:created_at, :utc_datetime)
    field(:updated_at, :utc_datetime)

    has_many(:sessions, SymphonyElixir.Store.Session)
  end

  @required_fields ~w(name)a
  @optional_fields ~w(linear_project_slug linear_organization_slug linear_filter_by linear_label_name github_repo workspace_root)a

  @spec changeset(%__MODULE__{} | Ecto.Changeset.t(), map()) :: Ecto.Changeset.t()
  def changeset(project, attrs) do
    project
    |> cast(attrs, @required_fields ++ @optional_fields)
    |> validate_required(@required_fields)
    |> validate_inclusion(:linear_filter_by, ["project", "label"])
  end
end
