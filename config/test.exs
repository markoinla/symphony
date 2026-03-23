import Config

test_db_path =
  Path.expand("../tmp/symphony_test-#{System.pid()}.db", __DIR__)

config :symphony_elixir, SymphonyElixir.Repo, database: test_db_path

config :symphony_elixir, SymphonyElixirWeb.Endpoint, check_origin: false
