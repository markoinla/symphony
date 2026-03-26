defmodule SymphonyElixir.Store.WebhookLog do
  @moduledoc """
  Ecto schema for tracking Linear webhook events and their dispatch outcomes.
  """

  use Ecto.Schema
  import Ecto.Changeset

  schema "webhook_logs" do
    field(:webhook_type, :string)
    field(:action, :string)
    field(:issue_id, :string)
    field(:issue_identifier, :string)
    field(:state_name, :string)
    field(:result, :string)
    field(:detail, :string)
    field(:payload_summary, :map)
    field(:organization_id, Ecto.UUID)
    field(:received_at, :utc_datetime)
  end

  @required_fields ~w(webhook_type action result received_at)a
  @optional_fields ~w(issue_id issue_identifier state_name detail payload_summary organization_id)a

  @spec changeset(%__MODULE__{} | Ecto.Changeset.t(), map()) :: Ecto.Changeset.t()
  def changeset(struct, attrs) do
    struct
    |> cast(attrs, @required_fields ++ @optional_fields)
    |> validate_required(@required_fields)
  end
end
