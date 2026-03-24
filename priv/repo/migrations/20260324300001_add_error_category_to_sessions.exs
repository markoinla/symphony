defmodule SymphonyElixir.Repo.Migrations.AddErrorCategoryToSessions do
  use Ecto.Migration

  def up do
    execute """
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS error_category varchar(255)
    """
  end

  def down do
    alter table(:sessions) do
      remove :error_category
    end
  end
end
