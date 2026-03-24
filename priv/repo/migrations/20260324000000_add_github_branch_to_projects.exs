defmodule SymphonyElixir.Repo.Migrations.AddGithubBranchToProjects do
  use Ecto.Migration

  def change do
    alter table(:projects) do
      add :github_branch, :string
    end
  end
end
