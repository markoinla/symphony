defmodule SymphonyElixirWeb.OAuthController do
  @moduledoc """
  Handles the Linear OAuth2 authorization code flow.

  Provides endpoints for initiating authorization, handling the callback,
  checking connection status, and revoking access.
  """

  use Phoenix.Controller, formats: [:json]

  require Logger

  alias Plug.Conn
  alias SymphonyElixir.Linear.{Client, OAuth}
  alias SymphonyElixir.{ProxyClient, Store}

  @spec authorize(Conn.t(), map()) :: Conn.t()
  def authorize(conn, _params) do
    if ProxyClient.proxy_enabled?() do
      authorize_via_proxy(conn)
    else
      authorize_direct(conn)
    end
  end

  defp authorize_direct(conn) do
    state = :crypto.strong_rand_bytes(32) |> Base.url_encode64(padding: false)
    redirect_uri = build_redirect_uri(conn)

    :ok = OAuth.store_state(state)

    case OAuth.authorize_url(state, redirect_uri) do
      {:ok, url} ->
        json(conn, %{authorize_url: url, flow: "direct"})

      {:error, :missing_client_id} ->
        error_response(conn, 422, "missing_client_id", "Linear OAuth client ID is not configured. Save it in settings first.")
    end
  end

  defp authorize_via_proxy(conn) do
    case ProxyClient.start_oauth_flow(:linear) do
      {:ok, %{url: url, state: state, code_verifier: code_verifier}} ->
        :ok = ProxyClient.store_pending_flow(:linear, state, code_verifier)
        json(conn, %{authorize_url: url, state: state, flow: "proxy"})
    end
  end

  @spec callback(Conn.t(), map()) :: Conn.t()
  def callback(conn, params) do
    redirect_uri = build_redirect_uri(conn)

    with {:ok, code} <- fetch_param(params, "code"),
         {:ok, state} <- fetch_param(params, "state"),
         :ok <- OAuth.validate_state(state),
         {:ok, _token_data} <- OAuth.exchange_code(code, redirect_uri) do
      sync_linear_org_id()
      maybe_register_instance()
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
      credentials_source: Atom.to_string(OAuth.credentials_source()),
      proxy_available: ProxyClient.proxy_enabled?()
    })
  end

  @spec proxy_poll(Conn.t(), map()) :: Conn.t()
  def proxy_poll(conn, _params) do
    case ProxyClient.get_pending_flow(:linear) do
      {:ok, state, code_verifier} ->
        case ProxyClient.poll_token(state, code_verifier) do
          {:ok, tokens} ->
            ProxyClient.clear_pending_flow(:linear)
            store_proxy_tokens(tokens)
            sync_linear_org_id()
            maybe_register_instance()
            json(conn, %{status: "complete"})

          {:pending} ->
            json(conn, %{status: "pending"})

          {:expired} ->
            ProxyClient.clear_pending_flow(:linear)
            error_response(conn, 410, "expired", "OAuth flow expired. Please try again.")

          {:error, reason} ->
            error_response(conn, 502, "poll_failed", "Token poll failed: #{inspect(reason)}")
        end

      {:error, :no_pending_flow} ->
        error_response(conn, 404, "no_pending_flow", "No proxy OAuth flow in progress.")
    end
  end

  defp store_proxy_tokens(%{access_token: access_token} = tokens) do
    token_data =
      %{"access_token" => access_token}
      |> then(fn m -> if tokens.refresh_token, do: Map.put(m, "refresh_token", tokens.refresh_token), else: m end)
      |> then(fn m ->
        if tokens.expires_at do
          now = DateTime.utc_now() |> DateTime.to_unix()
          Map.put(m, "expires_in", max(tokens.expires_at - now, 0))
        else
          m
        end
      end)

    OAuth.store_tokens(token_data)
  end

  defp sync_linear_org_id do
    case Client.fetch_organization_id() do
      {:ok, org_id} ->
        Store.put_setting("proxy.linear_org_id", org_id)
        Logger.info("Synced Linear organization ID: #{org_id}")

      {:error, reason} ->
        Logger.warning("Failed to fetch Linear organization ID: #{inspect(reason)}")
    end
  end

  defp maybe_register_instance do
    base_url = SymphonyElixir.resolve_public_base_url()
    org_id = Store.get_setting("proxy.linear_org_id")

    if is_binary(base_url) and is_binary(org_id) and org_id != "" do
      Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
        ProxyClient.register_instance(base_url, org_id)
      end)
    end

    :ok
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
