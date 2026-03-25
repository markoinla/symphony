defmodule SymphonyElixir.Store.UserOrganization do
  @moduledoc """
  Ecto schema for the join between users and organizations.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          user_id: Ecto.UUID.t() | nil,
          organization_id: Ecto.UUID.t() | nil,
          role: String.t() | nil,
          inserted_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "user_organizations" do
    field(:role, :string, default: "member")

    belongs_to(:user, SymphonyElixir.Store.User)
    belongs_to(:organization, SymphonyElixir.Store.Organization)

    # Only inserted_at, no updated_at for join records
    field(:inserted_at, :utc_datetime, read_after_writes: true)
  end

  @required_fields ~w(user_id organization_id)a
  @optional_fields ~w(role)a
  @valid_roles ~w(owner admin member)

  @spec changeset(%__MODULE__{} | Ecto.Changeset.t(), map()) :: Ecto.Changeset.t()
  def changeset(user_organization, attrs) do
    user_organization
    |> cast(attrs, @required_fields ++ @optional_fields)
    |> validate_required(@required_fields)
    |> validate_inclusion(:role, @valid_roles)
    |> foreign_key_constraint(:user_id)
    |> foreign_key_constraint(:organization_id)
    |> unique_constraint([:user_id, :organization_id])
  end
end
