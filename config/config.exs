import Config

config :logger, :default_formatter, metadata: [:request_id, :issue_id, :issue_identifier, :session_id, :agent_session_id]

config :phoenix, :json_library, Jason

config :symphony_elixir, ecto_repos: [SymphonyElixir.Repo]

config :symphony_elixir, SymphonyElixirWeb.Endpoint,
  adapter: Bandit.PhoenixAdapter,
  url: [host: "localhost"],
  render_errors: [
    formats: [html: SymphonyElixirWeb.ErrorHTML, json: SymphonyElixirWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: SymphonyElixir.PubSub,
  secret_key_base:
    System.get_env("SYMPHONY_SECRET_KEY_BASE") ||
      Base.encode64(:crypto.strong_rand_bytes(48), padding: false),
  check_origin: ["https://symphony.marko.la"],
  server: false

import_config "#{config_env()}.exs"
