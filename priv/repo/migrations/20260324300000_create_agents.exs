defmodule SymphonyElixir.Repo.Migrations.CreateAgents do
  use Ecto.Migration

  def change do
    create table(:agents) do
      add :name, :string, null: false
      add :enabled, :boolean, null: false, default: true
      add :inserted_at, :utc_datetime, null: false
      add :updated_at, :utc_datetime, null: false
    end

    create unique_index(:agents, [:name])
  end
end
