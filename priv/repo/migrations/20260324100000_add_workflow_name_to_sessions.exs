defmodule SymphonyElixir.Repo.Migrations.AddWorkflowNameToSessions do
  use Ecto.Migration

  def change do
    alter table(:sessions) do
      add :workflow_name, :string
    end
  end
end
