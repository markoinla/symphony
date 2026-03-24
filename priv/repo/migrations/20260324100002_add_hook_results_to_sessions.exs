defmodule SymphonyElixir.Repo.Migrations.AddHookResultsToSessions do
  use Ecto.Migration

  def up do
    execute """
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS hook_results jsonb[]
    """
  end

  def down do
    alter table(:sessions) do
      remove :hook_results
    end
  end
end
