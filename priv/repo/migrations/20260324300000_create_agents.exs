defmodule SymphonyElixir.Repo.Migrations.CreateAgents do
  use Ecto.Migration

  def up do
    execute """
    CREATE TABLE IF NOT EXISTS agents (
      id bigserial PRIMARY KEY,
      name varchar(255) NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      inserted_at timestamp(0) NOT NULL,
      updated_at timestamp(0) NOT NULL
    )
    """

    execute """
    CREATE UNIQUE INDEX IF NOT EXISTS agents_name_index ON agents (name)
    """
  end

  def down do
    drop_if_exists table(:agents)
  end
end
