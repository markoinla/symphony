defmodule SymphonyElixir.Repo.Migrations.AddLinearProjectIdToProjects do
  use Ecto.Migration

  def change do
    alter table(:projects) do
      add :linear_project_id, :string
    end
  end
end
