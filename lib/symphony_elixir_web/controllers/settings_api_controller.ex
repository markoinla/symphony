defmodule SymphonyElixirWeb.SettingsApiController do
  @moduledoc """
  JSON CRUD API for persisted settings.
  """

  use Phoenix.Controller, formats: [:json]

  require Logger

  alias Plug.Conn
  alias SymphonyElixir.{Caddy, ProxyClient, Store}
  alias SymphonyElixirWeb.{ObservabilityPubSub, Presenter}

  @spec index(Conn.t(), map()) :: Conn.t()
  def index(conn, _params) do
    json(conn, Presenter.settings_payload())
  end

  @spec upsert(Conn.t(), map()) :: Conn.t()
  def upsert(conn, %{"key" => key} = params) do
    value = Map.get(params, "value")

    if is_binary(value) do
      case Store.put_setting(key, value) do
        {:ok, setting} ->
          maybe_configure_caddy_domain(key, value)
          maybe_reregister_proxy(key, value)
          ObservabilityPubSub.broadcast_settings_changed()
          json(conn, %{setting: %{key: setting.key, value: setting.value}})

        {:error, changeset} ->
          changeset_error_response(conn, changeset)
      end
    else
      error_response(conn, 422, "invalid_setting", "Setting value is required")
    end
  end

  @spec delete(Conn.t(), map()) :: Conn.t()
  def delete(conn, %{"key" => key}) do
    case Store.delete_setting(key) do
      {:ok, _setting} ->
        maybe_remove_caddy_domain(key)
        ObservabilityPubSub.broadcast_settings_changed()
        send_resp(conn, 204, "")

      {:error, :not_found} ->
        error_response(conn, 404, "setting_not_found", "Setting not found")
    end
  end

  defp changeset_error_response(conn, changeset) do
    conn
    |> put_status(:unprocessable_entity)
    |> json(%{
      error: %{
        code: "invalid_setting",
        message: "Setting is invalid",
        details: Ecto.Changeset.traverse_errors(changeset, fn {message, _opts} -> message end)
      }
    })
  end

  defp maybe_configure_caddy_domain("domain", value) when is_binary(value) and value != "" do
    case Caddy.configure_domain(value) do
      :ok -> :ok
      {:error, reason} -> Logger.warning("Caddy domain configuration failed: #{inspect(reason)}")
    end

    domain = value |> String.replace(~r{^https?://}, "") |> String.trim_trailing("/")
    base_url = "https://#{domain}"
    Store.put_setting("symphony_public_base_url", base_url)
    maybe_register_proxy(base_url)
  end

  defp maybe_configure_caddy_domain(_key, _value), do: :ok

  defp maybe_remove_caddy_domain("domain") do
    case Caddy.remove_domain() do
      :ok -> :ok
      {:error, reason} -> Logger.warning("Caddy domain removal failed: #{inspect(reason)}")
    end

    Store.delete_setting("symphony_public_base_url")
    maybe_deregister_proxy()
  end

  defp maybe_remove_caddy_domain(_key), do: :ok

  defp maybe_reregister_proxy("symphony_public_base_url", value)
       when is_binary(value) and value != "" do
    maybe_register_proxy(value)
  end

  defp maybe_reregister_proxy(_key, _value), do: :ok

  defp maybe_register_proxy(base_url) do
    with org_id when is_binary(org_id) and org_id != "" <- Store.get_setting("proxy.linear_org_id"),
         true <- ProxyClient.proxy_enabled?() do
      Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
        do_register_proxy(base_url, org_id)
      end)
    end
  end

  defp do_register_proxy(base_url, org_id) do
    case ProxyClient.register_instance(base_url, org_id) do
      :ok -> Logger.info("Re-registered with proxy after domain change: #{base_url}")
      {:error, reason} -> Logger.warning("Proxy re-registration failed: #{inspect(reason)}")
    end
  end

  defp maybe_deregister_proxy do
    with org_id when is_binary(org_id) and org_id != "" <- Store.get_setting("proxy.linear_org_id"),
         true <- ProxyClient.proxy_enabled?() do
      Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
        do_deregister_proxy(org_id)
      end)
    end
  end

  defp do_deregister_proxy(org_id) do
    case ProxyClient.deregister_instance(org_id) do
      :ok -> Logger.info("Deregistered from proxy after domain removal")
      {:error, reason} -> Logger.warning("Proxy deregistration failed: #{inspect(reason)}")
    end
  end

  defp error_response(conn, status, code, message) do
    conn
    |> put_status(status)
    |> json(%{error: %{code: code, message: message}})
  end
end
