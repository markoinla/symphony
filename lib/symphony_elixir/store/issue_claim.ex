defmodule SymphonyElixir.Store.IssueClaim do
  @moduledoc """
  Ecto schema for cross-orchestrator issue dispatch claims.

  Each row represents an active claim on a Linear issue, preventing
  other orchestrators from dispatching the same issue concurrently.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:issue_id, :string, autogenerate: false}

  schema "issue_claims" do
    field(:orchestrator_key, :string)
    field(:claimed_at, :utc_datetime)
    field(:organization_id, :binary_id)

    belongs_to(:organization, SymphonyElixir.Store.Organization, type: :binary_id, define_field: false)
  end

  @required_fields ~w(issue_id orchestrator_key claimed_at)a
  @optional_fields ~w(organization_id)a

  @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
  def changeset(claim, attrs) do
    claim
    |> cast(attrs, @required_fields ++ @optional_fields)
    |> validate_required(@required_fields)
    |> unique_constraint(:issue_id, name: :issue_claims_pkey)
  end
end
