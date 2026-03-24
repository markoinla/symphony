defmodule SymphonyElixir.Repo.Migrations.AddAnalyticsColumnsToSessions do
  use Ecto.Migration

  def change do
    alter table(:sessions) do
      add :workflow, :string
      add :estimated_cost_cents, :integer
    end
  end
end
