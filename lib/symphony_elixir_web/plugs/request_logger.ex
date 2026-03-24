defmodule SymphonyElixirWeb.Plugs.RequestLogger do
  @moduledoc """
  Plug that logs method, path, status code, and response duration for API requests.

  Uses `Plug.Conn.register_before_send/2` to capture the response status and
  compute elapsed time from when the request entered the plug.
  """

  require Logger

  @behaviour Plug

  @impl true
  @spec init(keyword()) :: keyword()
  def init(opts), do: opts

  @impl true
  @spec call(Plug.Conn.t(), keyword()) :: Plug.Conn.t()
  def call(conn, _opts) do
    start_time = System.monotonic_time()

    Plug.Conn.register_before_send(conn, fn conn ->
      duration_us = System.monotonic_time() - start_time
      duration_ms = System.convert_time_unit(duration_us, :native, :microsecond) / 1000

      Logger.info("method=#{conn.method} path=#{conn.request_path} status=#{conn.status} duration_ms=#{Float.round(duration_ms, 2)}")

      conn
    end)
  end
end
