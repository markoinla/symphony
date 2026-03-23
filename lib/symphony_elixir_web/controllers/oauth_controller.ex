defmodule SymphonyElixirWeb.OAuthController do
  @moduledoc """
  Handles the Linear OAuth2 authorization code flow.

  Provides endpoints for initiating authorization, handling the callback,
  checking connection status, and revoking access.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixir.Linear.OAuth

  @spec authorize(Conn.t(), map()) :: Conn.t()
  def authorize(conn, _params) do
    state = :crypto.strong_rand_bytes(32) |> Base.url_encode64(padding: false)
    redirect_uri = build_redirect_uri(conn)

    :ok = OAuth.store_state(state)

    case OAuth.authorize_url(state, redirect_uri) do
      {:ok, url} ->
        json(conn, %{authorize_url: url})

      {:error, :missing_client_id} ->
        error_response(conn, 422, "missing_client_id", "Linear OAuth client ID is not configured. Save it in settings first.")
    end
  end

  @spec callback(Conn.t(), map()) :: Conn.t()
  def callback(conn, params) do
    redirect_uri = build_redirect_uri(conn)

    with {:ok, code} <- fetch_param(params, "code"),
         {:ok, state} <- fetch_param(params, "state"),
         :ok <- OAuth.validate_state(state),
         {:ok, _token_data} <- OAuth.exchange_code(code, redirect_uri) do
      do_redirect(conn, "/settings?oauth=success")
    else
      {:error, :missing_param} ->
        error = params["error"] || "missing_code"
        do_redirect(conn, "/settings?oauth=error&message=#{URI.encode(error)}")

      {:error, :invalid_state} ->
        do_redirect(conn, "/settings?oauth=error&message=invalid_state")

      {:error, reason} ->
        message = inspect(reason)
        do_redirect(conn, "/settings?oauth=error&message=#{URI.encode(message)}")
    end
  end

  @spec status(Conn.t(), map()) :: Conn.t()
  def status(conn, _params) do
    {status, expires_at} = OAuth.connection_status()

    json(conn, %{
      status: Atom.to_string(status),
      expires_at: expires_at,
      credentials_source: Atom.to_string(OAuth.credentials_source())
    })
  end

  @spec revoke(Conn.t(), map()) :: Conn.t()
  def revoke(conn, _params) do
    :ok = OAuth.revoke()
    json(conn, %{status: "disconnected"})
  end

  defp do_redirect(conn, path) do
    conn
    |> put_resp_header("location", path)
    |> send_resp(302, "")
  end

  defp build_redirect_uri(_conn) do
    base_url =
      SymphonyElixir.Store.get_setting("server.public_base_url") ||
        non_blank_env("SYMPHONY_PUBLIC_BASE_URL") ||
        SymphonyElixirWeb.Endpoint.url()

    base_url
    |> String.trim_trailing("/")
    |> Kernel.<>("/api/v1/oauth/linear/callback")
  end

  defp non_blank_env(var) do
    case System.get_env(var) do
      nil -> nil
      "" -> nil
      val -> val
    end
  end

  defp fetch_param(params, key) do
    case Map.get(params, key) do
      nil -> {:error, :missing_param}
      "" -> {:error, :missing_param}
      value -> {:ok, value}
    end
  end

  defp error_response(conn, status, code, message) do
    conn
    |> put_status(status)
    |> json(%{error: %{code: code, message: message}})
  end
end
