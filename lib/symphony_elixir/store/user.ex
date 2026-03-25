defmodule SymphonyElixir.Store.User do
  @moduledoc """
  Ecto schema for user accounts.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          email: String.t() | nil,
          hashed_password: String.t() | nil,
          name: String.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "users" do
    field(:email, :string)
    field(:hashed_password, :string)
    field(:name, :string)

    has_many(:user_organizations, SymphonyElixir.Store.UserOrganization)
    has_many(:organizations, through: [:user_organizations, :organization])

    timestamps(type: :utc_datetime)
  end

  @required_fields ~w(email hashed_password)a
  @optional_fields ~w(name)a

  @spec changeset(%__MODULE__{} | Ecto.Changeset.t(), map()) :: Ecto.Changeset.t()
  def changeset(user, attrs) do
    user
    |> cast(attrs, @required_fields ++ @optional_fields)
    |> validate_required(@required_fields)
    |> validate_format(:email, ~r/^[^\s]+@[^\s]+$/, message: "must have the @ sign and no spaces")
    |> validate_length(:email, max: 160)
    |> unique_constraint(:email)
  end

  @spec registration_changeset(%__MODULE__{} | Ecto.Changeset.t(), map()) :: Ecto.Changeset.t()
  def registration_changeset(user, attrs) do
    user
    |> cast(attrs, [:email, :name, :hashed_password])
    |> validate_required([:email])
    |> validate_format(:email, ~r/^[^\s]+@[^\s]+$/, message: "must have the @ sign and no spaces")
    |> validate_length(:email, max: 160)
    |> unique_constraint(:email)
    |> hash_password(attrs)
  end

  defp hash_password(changeset, attrs) do
    password = Map.get(attrs, :password) || Map.get(attrs, "password")

    if password do
      changeset
      |> validate_length(:hashed_password, is: 0, message: "cannot set both password and hashed_password")
      |> put_change(:hashed_password, Bcrypt.hash_pwd_salt(password))
    else
      changeset
      |> validate_required([:hashed_password])
    end
  end
end
