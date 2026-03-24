defmodule SymphonyElixir.Store.Agent do
  @moduledoc """
  Ecto schema for agent workflow entries.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @type t :: %__MODULE__{
          id: integer() | nil,
          name: String.t() | nil,
          enabled: boolean(),
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "agents" do
    field(:name, :string)
    field(:enabled, :boolean, default: true)
    field(:inserted_at, :utc_datetime)
    field(:updated_at, :utc_datetime)
  end

  @required_fields ~w(name)a
  @optional_fields ~w(enabled)a

  @spec changeset(%__MODULE__{} | Ecto.Changeset.t(), map()) :: Ecto.Changeset.t()
  def changeset(agent, attrs) do
    agent
    |> cast(attrs, @required_fields ++ @optional_fields)
    |> validate_required(@required_fields)
  end
end
