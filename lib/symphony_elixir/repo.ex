defmodule SymphonyElixir.Repo do
  @moduledoc """
  Ecto repository backed by PostgreSQL for persistent storage.
  """

  use Ecto.Repo, otp_app: :symphony_elixir, adapter: Ecto.Adapters.Postgres
end
