import Config

config :phoenix, :json_library, Jason

config :symphony_elixir, SymphonyElixir.Repo, database: Path.expand("~/.symphony/symphony.db")

config :symphony_elixir, SymphonyElixirWeb.Endpoint,
  adapter: Bandit.PhoenixAdapter,
  url: [host: "localhost"],
  render_errors: [
    formats: [html: SymphonyElixirWeb.ErrorHTML, json: SymphonyElixirWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: SymphonyElixir.PubSub,
  secret_key_base: String.duplicate("s", 64),
  check_origin: false,
  server: false

import_config "#{config_env()}.exs"
