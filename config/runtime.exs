import Config

if config_env() != :test do
  Dotenvy.source([".env", ".env.#{config_env()}"])
end
