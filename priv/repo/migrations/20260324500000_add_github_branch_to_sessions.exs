defmodule SymphonyElixir.Repo.Migrations.AddGithubBranchToSessions do
  use Ecto.Migration

  def change do
    alter table(:sessions) do
      add :github_branch, :string
    end
  end
end
