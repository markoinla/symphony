defmodule SymphonyElixir.Repo.Migrations.AddConfigSnapshotToSessions do
  use Ecto.Migration

  def change do
    alter table(:sessions) do
      add :config_snapshot, :map
    end
  end
end
