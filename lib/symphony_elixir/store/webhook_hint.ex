defmodule SymphonyElixir.Store.WebhookHint do
  @moduledoc """
  Ecto schema for the durable webhook hint queue.

  Issue state-change webhooks are persisted here and drained by the
  orchestrator on a fast interval, replacing the previous fire-and-forget
  GenServer cast approach.
  """

  use Ecto.Schema
  import Ecto.Changeset

  schema "webhook_hint_queue" do
    field(:issue_id, :string)
    field(:meta, :map)
    field(:inserted_at, :utc_datetime)
  end

  @required_fields ~w(issue_id inserted_at)a
  @optional_fields ~w(meta)a

  @spec changeset(%__MODULE__{} | Ecto.Changeset.t(), map()) :: Ecto.Changeset.t()
  def changeset(struct, attrs) do
    struct
    |> cast(attrs, @required_fields ++ @optional_fields)
    |> validate_required(@required_fields)
  end
end
