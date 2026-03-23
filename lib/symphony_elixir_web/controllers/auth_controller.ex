defmodule SymphonyElixirWeb.AuthController do
  @moduledoc """
  Handles session-based password authentication for the Symphony dashboard.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixirWeb.Plugs.RequireAuth

  @spec login(Conn.t(), map()) :: Conn.t()
  def login(conn, %{"password" => password}) do
    case System.get_env("SYMPHONY_AUTH_PASSWORD") do
      nil ->
        conn
        |> put_status(500)
        |> json(%{error: %{code: "not_configured", message: "Authentication is not configured"}})

      expected when is_binary(expected) ->
        if Plug.Crypto.secure_compare(password, expected) do
          conn
          |> fetch_session()
          |> put_session(:authenticated, true)
          |> configure_session(renew: true)
          |> json(%{ok: true})
        else
          conn
          |> put_status(401)
          |> json(%{error: %{code: "unauthorized", message: "Invalid password"}})
        end
    end
  end

  def login(conn, _params) do
    conn
    |> put_status(400)
    |> json(%{error: %{code: "bad_request", message: "Password is required"}})
  end

  @spec logout(Conn.t(), map()) :: Conn.t()
  def logout(conn, _params) do
    conn
    |> fetch_session()
    |> configure_session(drop: true)
    |> json(%{ok: true})
  end

  @spec status(Conn.t(), map()) :: Conn.t()
  def status(conn, _params) do
    authenticated =
      if RequireAuth.auth_configured?() do
        conn
        |> fetch_session()
        |> get_session(:authenticated)
        |> truthy?()
      else
        true
      end

    json(conn, %{
      authenticated: authenticated,
      auth_required: RequireAuth.auth_configured?()
    })
  end

  defp truthy?(true), do: true
  defp truthy?(_), do: false
end
