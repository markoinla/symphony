import Config

if config_env() != :test do
  Dotenvy.source([".env", ".env.#{config_env()}"])
end

database_url =
  System.get_env("DATABASE_URL") ||
    raise """
    environment variable DATABASE_URL is missing.
    For example: ecto://USER:PASS@HOST/DATABASE
    """

config :symphony_elixir, SymphonyElixir.Repo, url: database_url
