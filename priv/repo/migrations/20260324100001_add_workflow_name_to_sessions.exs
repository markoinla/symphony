defmodule SymphonyElixir.Repo.Migrations.AddWorkflowNameToSessions do
  use Ecto.Migration

  def up do
    execute """
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workflow_name varchar(255)
    """
  end

  def down do
    alter table(:sessions) do
      remove :workflow_name
    end
  end
end
