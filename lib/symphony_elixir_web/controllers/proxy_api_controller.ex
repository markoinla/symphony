defmodule SymphonyElixirWeb.ProxyApiController do
  @moduledoc """
  API endpoints for managing the OAuth/webhook proxy.
  """

  use Phoenix.Controller, formats: [:json]

  require Logger

  alias Plug.Conn
  alias SymphonyElixir.ProxyClient
  alias SymphonyElixir.Store

  @spec health(Conn.t(), map()) :: Conn.t()
  def health(conn, _params) do
    case ProxyClient.health_check() do
      :ok ->
        json(conn, %{ok: true})

      {:error, reason} ->
        Logger.warning("Proxy health check failed: #{inspect(reason)}")

        conn
        |> put_status(502)
        |> json(%{ok: false, error: inspect(reason)})
    end
  end

  @spec register(Conn.t(), map()) :: Conn.t()
  def register(conn, _params) do
    base_url = SymphonyElixir.resolve_public_base_url()
    org_id = Store.get_setting("proxy.linear_org_id")

    cond do
      is_nil(base_url) ->
        error_response(conn, 422, "missing_base_url", "Set SYMPHONY_PUBLIC_BASE_URL or symphony_public_base_url before registering.")

      is_nil(org_id) or org_id == "" ->
        error_response(conn, 422, "missing_org_id", "Set proxy.linear_org_id before registering.")

      true ->
        case ProxyClient.register_instance(base_url, org_id) do
          :ok ->
            json(conn, %{ok: true})

          {:error, :unauthorized} ->
            error_response(conn, 401, "unauthorized", "Registration secret is invalid.")

          {:error, reason} ->
            Logger.warning("Proxy registration failed: #{inspect(reason)}")
            error_response(conn, 502, "registration_failed", "Proxy registration failed: #{inspect(reason)}")
        end
    end
  end

  @spec status(Conn.t(), map()) :: Conn.t()
  def status(conn, _params) do
    json(conn, %{
      enabled: ProxyClient.proxy_enabled?(),
      instance_url: SymphonyElixir.resolve_public_base_url() || "",
      linear_org_id: Store.get_setting("proxy.linear_org_id")
    })
  end

  @spec ping(Conn.t(), map()) :: Conn.t()
  def ping(conn, _params) do
    org_id = Store.get_setting("proxy.linear_org_id")

    if is_nil(org_id) or org_id == "" do
      json(conn, %{
        proxy: %{ok: false, error: "No Linear organization ID. Connect Linear OAuth first."},
        webhook: %{ok: false, error: "Cannot test without organization ID."}
      })
    else
      proxy_result = ping_proxy()
      webhook_result = ping_webhook(proxy_result, org_id)
      json(conn, %{proxy: proxy_result, webhook: webhook_result})
    end
  end

  defp ping_proxy do
    case ProxyClient.health_check() do
      :ok -> %{ok: true}
      {:error, reason} -> %{ok: false, error: inspect(reason)}
    end
  end

  defp ping_webhook(%{ok: true}, org_id) do
    case ProxyClient.ping_instance(org_id) do
      {:ok, body} -> body
      {:error, reason} -> %{ok: false, error: inspect(reason)}
    end
  end

  defp ping_webhook(_proxy_down, _org_id) do
    %{ok: false, error: "Skipped — proxy is unreachable."}
  end

  defp error_response(conn, status, code, message) do
    conn
    |> put_status(status)
    |> json(%{error: %{code: code, message: message}})
  end
end
