defmodule SymphonyElixir.Store.Message do
  @moduledoc """
  Ecto schema for persisted session messages.
  """

  use Ecto.Schema
  import Ecto.Changeset

  schema "messages" do
    field(:seq, :integer)
    field(:type, :string)
    field(:content, :string)
    field(:metadata, :string)
    field(:timestamp, :utc_datetime)

    belongs_to(:session, SymphonyElixir.Store.Session)
  end

  @required_fields ~w(session_id seq type content timestamp)a
  @optional_fields ~w(metadata)a

  @spec changeset(%__MODULE__{} | Ecto.Changeset.t(), map()) :: Ecto.Changeset.t()
  def changeset(message, attrs) do
    message
    |> cast(attrs, @required_fields ++ @optional_fields)
    |> validate_required(@required_fields)
    |> validate_inclusion(:type, ~w(response tool_call thinking turn_boundary error))
  end
end
