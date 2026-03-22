defmodule SymphonyElixirWeb.CacheBodyReader do
  @moduledoc """
  Custom body reader that caches the raw request body for webhook signature verification.

  Used as the `body_reader` option in `Plug.Parsers` so that the raw body
  is available in `conn.assigns.raw_body` after parsing.
  """

  @spec read_body(Plug.Conn.t(), keyword()) ::
          {:ok, binary(), Plug.Conn.t()} | {:more, binary(), Plug.Conn.t()} | {:error, term()}
  def read_body(conn, opts) do
    case Plug.Conn.read_body(conn, opts) do
      {:ok, body, conn} ->
        existing = Map.get(conn.assigns, :raw_body, "")
        conn = Plug.Conn.assign(conn, :raw_body, existing <> body)
        {:ok, body, conn}

      {:more, body, conn} ->
        existing = Map.get(conn.assigns, :raw_body, "")
        conn = Plug.Conn.assign(conn, :raw_body, existing <> body)
        {:more, body, conn}

      {:error, reason} ->
        {:error, reason}
    end
  end
end
