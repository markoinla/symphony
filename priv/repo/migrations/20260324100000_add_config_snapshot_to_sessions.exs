defmodule SymphonyElixir.Repo.Migrations.AddConfigSnapshotToSessions do
  use Ecto.Migration

  def up do
    execute """
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS config_snapshot jsonb
    """
  end

  def down do
    alter table(:sessions) do
      remove :config_snapshot
    end
  end
end
