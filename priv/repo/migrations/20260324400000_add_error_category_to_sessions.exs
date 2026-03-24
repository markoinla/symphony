defmodule SymphonyElixir.Repo.Migrations.AddErrorCategoryToSessions do
  use Ecto.Migration

  def change do
    alter table(:sessions) do
      add :error_category, :string
    end
  end
end
