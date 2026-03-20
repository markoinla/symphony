defmodule SymphonyElixir.Store.Setting do
  @moduledoc """
  Ecto schema for global key-value settings stored in SQLite.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:key, :string, autogenerate: false}

  schema "settings" do
    field(:value, :string)
  end

  @spec changeset(%__MODULE__{} | Ecto.Changeset.t(), map()) :: Ecto.Changeset.t()
  def changeset(setting, attrs) do
    setting
    |> cast(attrs, [:key, :value])
    |> validate_required([:key, :value])
  end
end
