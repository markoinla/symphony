defmodule SymphonyElixir.Repo.Migrations.AddAnalyticsColumnsToSessions do
  use Ecto.Migration

  def up do
    execute """
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workflow varchar(255)
    """

    execute """
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS estimated_cost_cents integer
    """
  end

  def down do
    alter table(:sessions) do
      remove :workflow
      remove :estimated_cost_cents
    end
  end
end
