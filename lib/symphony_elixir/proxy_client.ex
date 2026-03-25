defmodule SymphonyElixir.ProxyClient do
  @moduledoc """
  HTTP client for the Symphony OAuth proxy worker.

  Initiates OAuth flows via the proxy and polls for completed tokens using
  PKCE to verify ownership of the flow.
  """

  require Logger

  alias SymphonyElixir.PKCE
  alias SymphonyElixir.Store

  @default_proxy_url "https://proxy.symphony.dev"
  @poll_interval_ms 1_000
  @poll_timeout_ms 300_000

  @type tokens :: %{
          access_token: String.t(),
          refresh_token: String.t() | nil,
          expires_at: integer() | nil,
          scope: String.t() | nil
        }

  @type provider :: :linear | :github

  @spec proxy_enabled?() :: boolean()
  def proxy_enabled? do
    Store.get_setting("proxy.enabled") == "true"
  end

  @spec health_check() :: :ok | {:error, term()}
  def health_check do
    url = "#{proxy_base_url()}/health"

    case req_get(url, receive_timeout: 10_000) do
      {:ok, %{status: 200}} -> :ok
      {:ok, %{status: status, body: body}} -> {:error, {:unexpected_status, status, body}}
      {:error, reason} -> {:error, {:request_failed, reason}}
    end
  end

  @spec register_instance(String.t(), String.t()) :: :ok | {:error, term()}
  def register_instance(instance_url, linear_org_id)
      when is_binary(instance_url) and is_binary(linear_org_id) do
    url = "#{proxy_base_url()}/register"
    secret = registration_secret()

    case req_post(url,
           json: %{"instance_url" => instance_url, "linear_org_id" => linear_org_id},
           headers: [{"authorization", "Bearer #{secret}"}],
           receive_timeout: 15_000
         ) do
      {:ok, %{status: 200}} ->
        Logger.info("Registered instance with proxy: #{instance_url}")
        :ok

      {:ok, %{status: 401}} ->
        {:error, :unauthorized}

      {:ok, %{status: status, body: body}} ->
        {:error, {:unexpected_status, status, body}}

      {:error, reason} ->
        {:error, {:request_failed, reason}}
    end
  end

  @spec start_oauth_flow(provider()) ::
          {:ok, %{url: String.t(), state: String.t(), code_verifier: String.t()}}
  def start_oauth_flow(provider) when provider in [:linear, :github] do
    %{code_verifier: code_verifier, code_challenge: code_challenge} = PKCE.generate()
    state = Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)

    proxy_url = proxy_base_url()

    url =
      "#{proxy_url}/authorize?" <>
        URI.encode_query(%{
          "provider" => Atom.to_string(provider),
          "state" => state,
          "code_challenge" => code_challenge
        })

    {:ok, %{url: url, state: state, code_verifier: code_verifier}}
  end

  @spec poll_token(String.t(), String.t()) ::
          {:ok, tokens()} | {:pending} | {:expired} | {:error, term()}
  def poll_token(state, code_verifier) when is_binary(state) and is_binary(code_verifier) do
    url = "#{proxy_base_url()}/token"

    case req_post(url,
           json: %{"state" => state, "code_verifier" => code_verifier},
           receive_timeout: 15_000
         ) do
      {:ok, %{status: 200, body: body}} ->
        {:ok, normalize_tokens(body)}

      {:ok, %{status: 202}} ->
        {:pending}

      {:ok, %{status: 401, body: body}} ->
        {:error, {:invalid_verifier, body}}

      {:ok, %{status: 410}} ->
        {:expired}

      {:ok, %{status: status, body: body}} ->
        {:error, {:unexpected_status, status, body}}

      {:error, reason} ->
        {:error, {:request_failed, reason}}
    end
  end

  @spec await_token(String.t(), String.t(), keyword()) ::
          {:ok, tokens()} | {:error, :timeout} | {:error, term()}
  def await_token(state, code_verifier, opts \\ []) do
    interval = Keyword.get(opts, :interval_ms, @poll_interval_ms)
    timeout = Keyword.get(opts, :timeout_ms, @poll_timeout_ms)
    deadline = System.monotonic_time(:millisecond) + timeout

    do_await(state, code_verifier, interval, deadline)
  end

  defp do_await(state, code_verifier, interval, deadline) do
    case poll_token(state, code_verifier) do
      {:ok, tokens} ->
        {:ok, tokens}

      {:pending} ->
        if System.monotonic_time(:millisecond) >= deadline do
          {:error, :timeout}
        else
          Process.sleep(interval)
          do_await(state, code_verifier, interval, deadline)
        end

      {:expired} ->
        {:error, :expired}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp normalize_tokens(body) when is_map(body) do
    %{
      access_token: body["access_token"],
      refresh_token: body["refresh_token"],
      expires_at: body["expires_at"],
      scope: body["scope"]
    }
  end

  defp req_get(url, opts) do
    extra = Application.get_env(:symphony_elixir, :proxy_req_options, [])
    Req.get(url, Keyword.merge(extra, opts))
  end

  defp req_post(url, opts) do
    extra = Application.get_env(:symphony_elixir, :proxy_req_options, [])
    Req.post(url, Keyword.merge(extra, opts))
  end

  @spec proxy_base_url() :: String.t()
  defp proxy_base_url do
    (Store.get_setting("proxy.url") ||
       System.get_env("SYMPHONY_PROXY_URL") ||
       @default_proxy_url)
    |> String.trim_trailing("/")
  end

  @spec store_pending_flow(provider(), String.t(), String.t()) :: :ok
  def store_pending_flow(provider, state, code_verifier) do
    prefix = "proxy_oauth.#{provider}"
    {:ok, _} = Store.put_setting("#{prefix}.state", state)
    {:ok, _} = Store.put_setting("#{prefix}.code_verifier", code_verifier)
    :ok
  end

  @spec get_pending_flow(provider()) :: {:ok, String.t(), String.t()} | {:error, :no_pending_flow}
  def get_pending_flow(provider) do
    prefix = "proxy_oauth.#{provider}"

    case {Store.get_setting("#{prefix}.state"), Store.get_setting("#{prefix}.code_verifier")} do
      {state, verifier} when is_binary(state) and is_binary(verifier) ->
        {:ok, state, verifier}

      _ ->
        {:error, :no_pending_flow}
    end
  end

  @spec clear_pending_flow(provider()) :: :ok
  def clear_pending_flow(provider) do
    prefix = "proxy_oauth.#{provider}"
    Store.delete_setting("#{prefix}.state")
    Store.delete_setting("#{prefix}.code_verifier")
    :ok
  end

  defp registration_secret do
    Store.get_setting("proxy.registration_secret") ||
      System.get_env("SYMPHONY_PROXY_REGISTRATION_SECRET") ||
      raise "No proxy registration secret configured. Set proxy.registration_secret or SYMPHONY_PROXY_REGISTRATION_SECRET."
  end
end
