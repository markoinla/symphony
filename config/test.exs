import Config

config :symphony_elixir, SymphonyElixir.Repo,
  url:
    System.get_env("DATABASE_URL") ||
      "ecto://postgres:postgres@localhost/symphony_test",
  pool: Ecto.Adapters.SQL.Sandbox

config :symphony_elixir, SymphonyElixirWeb.Endpoint,
  check_origin: false,
  secret_key_base: String.duplicate("t", 64)

config :symphony_elixir,
  proxy_req_options: [plug: {Req.Test, SymphonyElixir.ProxyClient}]
