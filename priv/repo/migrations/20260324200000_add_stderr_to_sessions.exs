defmodule SymphonyElixir.Repo.Migrations.AddStderrToSessions do
  use Ecto.Migration

  def change do
    alter table(:sessions) do
      add :stderr, :text
    end
  end
end
