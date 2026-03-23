defmodule SymphonyElixirWeb.Plugs.RequireAuth do
  @moduledoc """
  Plug that enforces session-based authentication.

  Checks for `:authenticated` flag in the session. When authentication is
  not configured (no `SYMPHONY_AUTH_PASSWORD` env var), all requests pass through.

  For API routes (Accept: application/json), returns 401 JSON.
  For browser routes, redirects to `/login`.
  """

  import Plug.Conn

  @behaviour Plug

  @impl true
  @spec init(keyword()) :: keyword()
  def init(opts), do: opts

  @impl true
  @spec call(Plug.Conn.t(), keyword()) :: Plug.Conn.t()
  def call(conn, _opts) do
    if auth_configured?() do
      conn
      |> fetch_session()
      |> check_auth()
    else
      conn
    end
  end

  defp check_auth(conn) do
    if get_session(conn, :authenticated) do
      conn
    else
      reject(conn)
    end
  end

  defp reject(conn) do
    if api_request?(conn) do
      conn
      |> put_resp_content_type("application/json")
      |> send_resp(401, Jason.encode!(%{error: %{code: "unauthorized", message: "Authentication required"}}))
      |> halt()
    else
      conn
      |> Phoenix.Controller.redirect(to: "/login")
      |> halt()
    end
  end

  defp api_request?(conn) do
    case get_req_header(conn, "accept") do
      [accept | _] -> String.contains?(accept, "application/json")
      _ -> false
    end
  end

  @spec auth_configured?() :: boolean()
  def auth_configured? do
    case System.get_env("SYMPHONY_AUTH_PASSWORD") do
      nil -> false
      "" -> false
      _ -> true
    end
  end
end
