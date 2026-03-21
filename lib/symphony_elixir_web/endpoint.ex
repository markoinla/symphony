defmodule SymphonyElixirWeb.Endpoint do
  @moduledoc """
  Phoenix endpoint for Symphony's optional observability UI and API.
  """

  use Phoenix.Endpoint, otp_app: :symphony_elixir

  plug(Plug.RequestId)
  plug(Plug.Telemetry, event_prefix: [:phoenix, :endpoint])

  plug(Plug.Static,
    at: "/",
    from: {:symphony_elixir, "priv/static/dashboard"},
    gzip: false
  )

  plug(Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Jason
  )

  plug(Plug.MethodOverride)
  plug(Plug.Head)
  plug(SymphonyElixirWeb.Router)
end
