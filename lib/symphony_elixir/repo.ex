defmodule SymphonyElixir.Repo do
  @moduledoc """
  Ecto repository backed by SQLite3 for persistent session storage.
  """

  use Ecto.Repo, otp_app: :symphony_elixir, adapter: Ecto.Adapters.SQLite3
end
