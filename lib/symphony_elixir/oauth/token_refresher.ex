defmodule SymphonyElixir.OAuth.TokenRefresher do
  @moduledoc """
  Proactively refreshes OAuth tokens before they expire.

  Runs a periodic check (default every 15 minutes) and refreshes any OAuth token
  that will expire within the proactive buffer window (default 30 minutes). This
  prevents tokens from silently expiring during idle periods, which would
  otherwise require users to manually re-authenticate.

  Currently handles Linear OAuth tokens. GitHub tokens are handled here as well
  for apps that enable token expiration, though most GitHub OAuth apps issue
  non-expiring tokens.
  """

  use GenServer

  require Logger

  @check_interval_ms :timer.minutes(15)
  @proactive_buffer_seconds 1_800

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    schedule_check()
    {:ok, %{}}
  end

  @impl true
  def handle_info(:check_tokens, state) do
    refresh_if_needed("linear_oauth", &SymphonyElixir.Linear.OAuth.refresh_token/0)
    refresh_if_needed("github_oauth", &refresh_github_token/0)
    schedule_check()
    {:noreply, state}
  end

  defp refresh_if_needed(prefix, refresh_fn) do
    case seconds_until_expiry(prefix) do
      {:ok, seconds} when seconds > 0 and seconds < @proactive_buffer_seconds ->
        do_refresh(prefix, refresh_fn, seconds)

      _ ->
        :ok
    end
  end

  defp seconds_until_expiry(prefix) do
    store = SymphonyElixir.Store

    with expires_str when is_binary(expires_str) <- store.get_setting("#{prefix}.expires_at"),
         refresh when is_binary(refresh) <- store.get_setting("#{prefix}.refresh_token"),
         {:ok, expires_at, _} <- DateTime.from_iso8601(expires_str) do
      {:ok, DateTime.diff(expires_at, DateTime.utc_now(), :second)}
    else
      _ -> :skip
    end
  end

  defp do_refresh(prefix, refresh_fn, seconds_remaining) do
    Logger.info("#{prefix}: token expires in #{seconds_remaining}s, refreshing proactively")

    case refresh_fn.() do
      {:ok, _} ->
        Logger.info("#{prefix}: proactive token refresh succeeded")

      {:error, reason} ->
        Logger.warning("#{prefix}: proactive token refresh failed: #{inspect(reason)}")
    end
  end

  defp refresh_github_token do
    # GitHub.OAuth.refresh_token/0 is private; call current_access_token/0
    # which triggers the lazy refresh internally when within the buffer window.
    # We widen the check here so that current_access_token still gets called
    # when there's time left, giving the internal maybe_refresh a chance to act.
    _ = SymphonyElixir.GitHub.OAuth.current_access_token()
    {:ok, :delegated}
  end

  defp schedule_check do
    Process.send_after(self(), :check_tokens, @check_interval_ms)
  end
end
