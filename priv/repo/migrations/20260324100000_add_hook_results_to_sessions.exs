defmodule SymphonyElixir.Repo.Migrations.AddHookResultsToSessions do
  use Ecto.Migration

  def change do
    alter table(:sessions) do
      add :hook_results, {:array, :map}
    end
  end
end
