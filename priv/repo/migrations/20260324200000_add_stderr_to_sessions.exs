defmodule SymphonyElixir.Repo.Migrations.AddStderrToSessions do
  use Ecto.Migration

  def up do
    execute """
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS stderr text
    """
  end

  def down do
    alter table(:sessions) do
      remove :stderr
    end
  end
end
