defmodule SymphonyElixir.Linear.OAuth do
  @moduledoc """
  Linear OAuth2 authorization code flow.

  Handles building authorize URLs, exchanging authorization codes for tokens,
  refreshing expired tokens, and revoking access. Tokens are stored in the
  settings database with `linear_oauth.*` keys.
  """

  require Logger

  alias SymphonyElixir.Store

  @authorize_url "https://linear.app/oauth/authorize"
  @token_url "https://api.linear.app/oauth/token"
  @revoke_url "https://api.linear.app/oauth/revoke"

  @refresh_buffer_seconds 300

  @type status :: :connected | :expired | :disconnected
  @type credentials_source :: :env | :store | :none

  @spec authorize_url(String.t(), String.t()) :: {:ok, String.t()} | {:error, :missing_client_id}
  def authorize_url(state, redirect_uri) when is_binary(state) and is_binary(redirect_uri) do
    case get_client_id() do
      nil ->
        {:error, :missing_client_id}

      client_id ->
        params =
          URI.encode_query(%{
            "client_id" => client_id,
            "redirect_uri" => redirect_uri,
            "response_type" => "code",
            "scope" => "write,read,app:assignable,app:mentionable",
            "state" => state,
            "actor" => "app"
          })

        {:ok, "#{@authorize_url}?#{params}"}
    end
  end

  @spec exchange_code(String.t(), String.t()) :: {:ok, map()} | {:error, term()}
  def exchange_code(code, redirect_uri) when is_binary(code) and is_binary(redirect_uri) do
    client_id = get_client_id()
    client_secret = get_client_secret()

    if is_nil(client_id) or is_nil(client_secret) do
      {:error, :missing_credentials}
    else
      body = %{
        "grant_type" => "authorization_code",
        "client_id" => client_id,
        "client_secret" => client_secret,
        "code" => code,
        "redirect_uri" => redirect_uri
      }

      case Req.post(@token_url, form: body, receive_timeout: 30_000) do
        {:ok, %{status: 200, body: token_data}} ->
          store_tokens(token_data)
          {:ok, token_data}

        {:ok, %{status: status, body: body}} ->
          Logger.error("Linear OAuth token exchange failed status=#{status} body=#{inspect(body)}")
          {:error, {:token_exchange_failed, status}}

        {:error, reason} ->
          Logger.error("Linear OAuth token exchange request failed: #{inspect(reason)}")
          {:error, {:token_exchange_request, reason}}
      end
    end
  end

  @spec refresh_token() :: {:ok, map()} | {:error, term()}
  def refresh_token do
    refresh_token = Store.get_setting("linear_oauth.refresh_token")
    client_id = get_client_id()
    client_secret = get_client_secret()

    if is_nil(refresh_token) or is_nil(client_id) do
      {:error, :missing_refresh_token}
    else
      body =
        %{
          "grant_type" => "refresh_token",
          "refresh_token" => refresh_token,
          "client_id" => client_id
        }
        |> maybe_put_secret(client_secret)

      case Req.post(@token_url, form: body, receive_timeout: 30_000) do
        {:ok, %{status: 200, body: token_data}} ->
          store_tokens(token_data)
          {:ok, token_data}

        {:ok, %{status: status, body: body}} ->
          Logger.error("Linear OAuth token refresh failed status=#{status} body=#{inspect(body)}")
          {:error, {:token_refresh_failed, status}}

        {:error, reason} ->
          Logger.error("Linear OAuth token refresh request failed: #{inspect(reason)}")
          {:error, {:token_refresh_request, reason}}
      end
    end
  end

  @spec credentials_source() :: credentials_source()
  def credentials_source do
    cond do
      Store.get_setting("linear_oauth.client_id") != nil -> :store
      has_env_credentials?() -> :env
      true -> :none
    end
  end

  @spec revoke() :: :ok | {:error, term()}
  def revoke do
    access_token = Store.get_setting("linear_oauth.access_token")

    if access_token do
      Req.post(@revoke_url,
        headers: [{"Authorization", "Bearer #{access_token}"}],
        receive_timeout: 30_000
      )
    end

    delete_all_oauth_settings()
    :ok
  end

  @spec current_access_token() :: String.t() | nil
  def current_access_token do
    case Store.get_setting("linear_oauth.access_token") do
      nil -> System.get_env("LINEAR_OAUTH_TOKEN")
      token -> maybe_refresh(token)
    end
  end

  defp maybe_refresh(token) do
    if token_needs_refresh?() do
      case refresh_token() do
        {:ok, %{"access_token" => refreshed}} -> refreshed
        {:error, _reason} -> token
      end
    else
      token
    end
  end

  @spec connection_status() :: {status(), String.t() | nil}
  def connection_status do
    case Store.get_setting("linear_oauth.access_token") do
      nil ->
        if System.get_env("LINEAR_OAUTH_TOKEN") do
          {:connected, nil}
        else
          {:disconnected, nil}
        end

      _token ->
        expires_at = Store.get_setting("linear_oauth.expires_at")

        if token_expired?(expires_at) do
          case refresh_token() do
            {:ok, _token_data} ->
              refreshed_expires_at = Store.get_setting("linear_oauth.expires_at")
              {:connected, refreshed_expires_at}

            {:error, _reason} ->
              {:expired, expires_at}
          end
        else
          {:connected, expires_at}
        end
    end
  end

  @spec store_state(String.t()) :: :ok
  def store_state(state) when is_binary(state) do
    {:ok, _} = Store.put_setting("linear_oauth.state", state)
    :ok
  end

  @spec validate_state(String.t()) :: :ok | {:error, :invalid_state}
  def validate_state(state) when is_binary(state) do
    case Store.get_setting("linear_oauth.state") do
      ^state ->
        Store.delete_setting("linear_oauth.state")
        :ok

      _ ->
        {:error, :invalid_state}
    end
  end

  @spec store_tokens(map()) :: :ok
  def store_tokens(%{"access_token" => access_token} = token_data) do
    {:ok, _} = Store.put_setting("linear_oauth.access_token", access_token)

    if refresh = token_data["refresh_token"] do
      {:ok, _} = Store.put_setting("linear_oauth.refresh_token", refresh)
    end

    if expires_in = token_data["expires_in"] do
      expires_at =
        DateTime.utc_now()
        |> DateTime.add(expires_in, :second)
        |> DateTime.truncate(:second)
        |> DateTime.to_iso8601()

      {:ok, _} = Store.put_setting("linear_oauth.expires_at", expires_at)
    end

    :ok
  end

  defp token_needs_refresh? do
    case Store.get_setting("linear_oauth.expires_at") do
      nil -> false
      expires_at_str -> within_refresh_buffer?(expires_at_str)
    end
  end

  defp within_refresh_buffer?(expires_at_str) do
    case DateTime.from_iso8601(expires_at_str) do
      {:ok, expires_at, _} ->
        DateTime.diff(expires_at, DateTime.utc_now(), :second) < @refresh_buffer_seconds

      _ ->
        false
    end
  end

  defp token_expired?(nil), do: false

  defp token_expired?(expires_at_str) do
    case DateTime.from_iso8601(expires_at_str) do
      {:ok, expires_at, _} -> DateTime.compare(expires_at, DateTime.utc_now()) == :lt
      _ -> false
    end
  end

  defp delete_all_oauth_settings do
    ~w(
      linear_oauth.access_token
      linear_oauth.refresh_token
      linear_oauth.expires_at
      linear_oauth.state
    )
    |> Enum.each(&Store.delete_setting/1)
  end

  defp has_env_credentials? do
    env_id = System.get_env("LINEAR_OAUTH_CLIENT_ID")
    env_secret = System.get_env("LINEAR_OAUTH_CLIENT_SECRET")
    is_binary(env_id) and env_id != "" and is_binary(env_secret) and env_secret != ""
  end

  defp get_client_id do
    Store.get_setting("linear_oauth.client_id") || System.get_env("LINEAR_OAUTH_CLIENT_ID")
  end

  defp get_client_secret do
    Store.get_setting("linear_oauth.client_secret") || System.get_env("LINEAR_OAUTH_CLIENT_SECRET")
  end

  defp maybe_put_secret(body, nil), do: body
  defp maybe_put_secret(body, secret), do: Map.put(body, "client_secret", secret)
end
