defmodule SymphonyElixir.Repo.Migrations.BackfillReliabilityFields do
  use Ecto.Migration

  def up do
    # Backfill error_category on cancelled sessions that have an error but no category
    execute("""
    UPDATE sessions
    SET error_category = 'infra'
    WHERE status = 'cancelled'
      AND error IS NOT NULL
      AND error_category IS NULL
    """)

    # Backfill worker_host to 'local' for sessions that ran without SSH workers
    execute("""
    UPDATE sessions
    SET worker_host = 'local'
    WHERE worker_host IS NULL
    """)
  end

  def down do
    execute("""
    UPDATE sessions
    SET error_category = NULL
    WHERE status = 'cancelled'
      AND error_category = 'infra'
    """)

    execute("""
    UPDATE sessions
    SET worker_host = NULL
    WHERE worker_host = 'local'
    """)
  end
end
