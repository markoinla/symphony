defmodule SymphonyElixir.Store.Organization do
  @moduledoc """
  Ecto schema for organizations.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          name: String.t() | nil,
          slug: String.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "organizations" do
    field(:name, :string)
    field(:slug, :string)

    has_many(:user_organizations, SymphonyElixir.Store.UserOrganization)
    has_many(:users, through: [:user_organizations, :user])

    timestamps(type: :utc_datetime)
  end

  @required_fields ~w(name slug)a

  @spec changeset(%__MODULE__{} | Ecto.Changeset.t(), map()) :: Ecto.Changeset.t()
  def changeset(organization, attrs) do
    organization
    |> cast(attrs, @required_fields)
    |> validate_required(@required_fields)
    |> validate_format(:slug, ~r/^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: "must be lowercase alphanumeric with hyphens")
    |> validate_length(:slug, min: 2, max: 100)
    |> unique_constraint(:slug)
  end
end
