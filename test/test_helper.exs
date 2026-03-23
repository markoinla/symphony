# Safety guard: ensure tests never use the production database.
# The production DB lives at ~/.symphony/symphony.db; tests must use a temp path.
prod_db = Path.expand("~/.symphony/symphony.db")
test_db = Application.get_env(:symphony_elixir, SymphonyElixir.Repo)[:database]

if test_db == prod_db do
  raise """
  SAFETY: Test suite is configured to use the production database!

  Production DB: #{prod_db}
  Configured DB: #{test_db}

  Ensure config/test.exs overrides the database path. Never run tests against
  the production database — this causes data loss.
  """
end

ExUnit.start(exclude: [:codex_required])
Code.require_file("support/snapshot_support.exs", __DIR__)
Code.require_file("support/test_support.exs", __DIR__)
