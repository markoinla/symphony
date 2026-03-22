defmodule SymphonyElixirWeb.SpaController do
  @moduledoc """
  Serves the built dashboard SPA shell for client-side routes.
  """

  use Phoenix.Controller, formats: [:html]

  alias Plug.Conn

  @test_fallback_shell """
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Symphony</title>
    </head>
    <body>
      <div id="root"></div>
    </body>
  </html>
  """

  @spec index(Conn.t(), map()) :: Conn.t()
  def index(conn, params) do
    path_segments = Map.get(params, "path", [])

    cond do
      Enum.any?(path_segments, &String.contains?(&1, ".")) ->
        send_resp(conn, 404, "Not found")

      File.exists?(index_path()) ->
        conn
        |> put_resp_content_type("text/html")
        |> send_file(200, index_path())

      Mix.env() == :test ->
        conn
        |> put_resp_content_type("text/html")
        |> send_resp(200, @test_fallback_shell)

      true ->
        send_resp(conn, 404, "Dashboard assets are not built")
    end
  end

  defp index_path do
    :symphony_elixir
    |> :code.priv_dir()
    |> to_string()
    |> Path.join("static/dashboard/index.html")
  end
end
