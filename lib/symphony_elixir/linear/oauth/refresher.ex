defmodule SymphonyElixir.Linear.OAuth.Refresher do
  @moduledoc """
  Owns Linear OAuth token refresh.

  Linear access tokens expire after 24 hours and refresh tokens rotate on
  every use. This GenServer:

    * proactively refreshes tokens before `expires_at`,
    * serializes refresh attempts so concurrent callers cannot race and
      invalidate each other's tokens (Linear rotates `refresh_token` on
      every successful exchange),
    * classifies failures — `invalid_grant` is terminal and surfaced as
      `:reconnect_required`; transient errors retry with backoff inside
      Linear's 30-minute network grace window.

  See Linear's OAuth docs for the external token refresh contract.
  """

  use GenServer

  require Logger

  alias SymphonyElixir.Linear.OAuth
  alias SymphonyElixir.Store

  # Refresh this many seconds before `expires_at`.
  @refresh_buffer_seconds 300
  # Cap the proactive timer so a far-future expiry doesn't sleep forever
  # (and so we recover from clock skew on long-running nodes).
  @max_schedule_ms 6 * 60 * 60 * 1000
  # Linear's network-resilience grace period for a refresh request.
  @transient_retry_window_ms 30 * 60 * 1000
  @transient_initial_backoff_ms 30 * 1000
  @transient_max_backoff_ms 5 * 60 * 1000
  @recent_refresh_skip_ms 5_000

  @type refresh_outcome ::
          {:ok, map()}
          | {:error, :missing_refresh_token}
          | {:error, {:invalid_grant, term()}}
          | {:error, {:transient, term()}}
          | {:error, {:token_refresh_failed, pos_integer(), term()}}
          | {:error, {:token_refresh_request, term()}}

  # ── Public API ───────────────────────────────────────────────────────

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc """
  Force a synchronous refresh. Used by the Linear HTTP client when an
  API call returns 401 — the call serializes through this GenServer so
  multiple concurrent 401s collapse into a single refresh attempt.
  """
  @spec force_refresh(timeout()) :: refresh_outcome()
  def force_refresh(timeout \\ 30_000) do
    case Process.whereis(__MODULE__) do
      nil -> OAuth.refresh_token()
      _pid -> GenServer.call(__MODULE__, :force_refresh, timeout)
    end
  end

  @spec refresh_if_needed(timeout()) :: refresh_outcome()
  def refresh_if_needed(timeout \\ 30_000) do
    case Process.whereis(__MODULE__) do
      nil ->
        if OAuth.token_needs_refresh?(), do: OAuth.refresh_token(), else: current_token_outcome()

      _pid ->
        GenServer.call(__MODULE__, :refresh_if_needed, timeout)
    end
  end

  @doc false
  @spec refresh_buffer_seconds() :: pos_integer()
  def refresh_buffer_seconds, do: @refresh_buffer_seconds

  @doc """
  Re-evaluate the schedule after tokens are written outside the
  Refresher (e.g. after the OAuth callback exchanges an authorization
  code for tokens).
  """
  @spec reschedule() :: :ok
  def reschedule do
    GenServer.cast(__MODULE__, :reschedule)
  end

  # ── GenServer ────────────────────────────────────────────────────────

  @impl true
  def init(_opts) do
    {:ok, %{timer: nil, transient_attempts: 0, retry_started_at: nil}, {:continue, :schedule}}
  end

  @impl true
  def handle_continue(:schedule, state) do
    {:noreply, schedule_next(state)}
  end

  @impl true
  def handle_cast(:reschedule, state) do
    {:noreply, schedule_next(state)}
  end

  @impl true
  def handle_info(:refresh, state) do
    {_outcome, state} = do_refresh(state)
    {:noreply, state}
  end

  @impl true
  def handle_call(:force_refresh, _from, state) do
    {outcome, state} = do_refresh(state)
    {:reply, outcome, state}
  end

  @impl true
  def handle_call(:refresh_if_needed, _from, state) do
    if OAuth.token_needs_refresh?() do
      {outcome, state} = do_refresh(state)
      {:reply, outcome, state}
    else
      {:reply, current_token_outcome(), state}
    end
  end

  # ── Refresh logic ────────────────────────────────────────────────────

  defp do_refresh(state) do
    state = cancel_timer(state)

    case maybe_recent_refresh_outcome() || OAuth.refresh_token() do
      {:ok, token_data} ->
        Logger.info("Linear OAuth token refreshed")
        Store.delete_settings(["linear_oauth.last_refresh_error"])
        {:ok, _} = Store.put_setting("linear_oauth.refresh_status", "ok")
        {:ok, _} = Store.put_setting("linear_oauth.last_refresh_at", iso_now())

        new_state = %{state | transient_attempts: 0, retry_started_at: nil}
        {{:ok, token_data}, schedule_next(new_state)}

      {:error, :missing_refresh_token} = err ->
        Logger.warning("Linear OAuth: no refresh_token stored; user must reconnect to obtain one")

        record_terminal_error("missing_refresh_token: reconnect required to obtain a refresh token")
        {err, %{state | timer: nil, transient_attempts: 0, retry_started_at: nil}}

      {:error, {:token_refresh_failed, status, body}} ->
        if invalid_grant?(status, body) do
          Logger.error("Linear OAuth refresh returned invalid_grant — reconnect required (status=#{status})")

          record_terminal_error(format_invalid_grant(body))
          {{:error, {:invalid_grant, body}}, %{state | timer: nil, transient_attempts: 0, retry_started_at: nil}}
        else
          handle_transient(state, {:token_refresh_failed, status})
        end

      {:error, {:token_refresh_request, reason}} ->
        handle_transient(state, {:request_failed, reason})

      {:error, other} ->
        handle_transient(state, other)
    end
  end

  defp maybe_recent_refresh_outcome do
    if recent_successful_refresh?() and not OAuth.token_needs_refresh?() do
      current_token_outcome()
    end
  end

  defp recent_successful_refresh? do
    case Store.get_setting("linear_oauth.last_refresh_at") do
      nil ->
        false

      value ->
        case DateTime.from_iso8601(value) do
          {:ok, refreshed_at, _} ->
            DateTime.diff(DateTime.utc_now(), refreshed_at, :millisecond) < @recent_refresh_skip_ms

          _ ->
            false
        end
    end
  end

  defp current_token_outcome do
    case Store.get_setting("linear_oauth.access_token") do
      token when is_binary(token) and token != "" -> {:ok, %{"access_token" => token}}
      _ -> {:error, :missing_refresh_token}
    end
  end

  defp handle_transient(state, reason) do
    started_at = state.retry_started_at || System.monotonic_time(:millisecond)
    attempts = state.transient_attempts + 1
    elapsed = System.monotonic_time(:millisecond) - started_at

    if elapsed < @transient_retry_window_ms do
      delay =
        @transient_initial_backoff_ms
        |> Kernel.*(Integer.pow(2, min(attempts - 1, 5)))
        |> min(@transient_max_backoff_ms)

      Logger.warning(
        "Linear OAuth refresh transient failure (attempt=#{attempts}, retry_in=#{delay}ms): " <>
          inspect(reason)
      )

      record_transient_error(reason)
      timer = Process.send_after(self(), :refresh, delay)

      new_state = %{state | timer: timer, transient_attempts: attempts, retry_started_at: started_at}
      {{:error, {:transient, reason}}, new_state}
    else
      Logger.error("Linear OAuth refresh giving up after 30-min grace window: #{inspect(reason)}")

      record_terminal_error("refresh_failed_after_grace: " <> inspect(reason))
      {{:error, {:transient, reason}}, %{state | timer: nil, transient_attempts: 0, retry_started_at: nil}}
    end
  end

  @doc false
  @spec invalid_grant?(integer(), term()) :: boolean()
  def invalid_grant?(status, body) when status in [400, 401] do
    case body do
      %{"error" => "invalid_grant"} -> true
      %{"error" => "unauthorized_client"} -> true
      %{"error" => "invalid_request"} -> false
      _ -> false
    end
  end

  def invalid_grant?(_status, _body), do: false

  @doc false
  @spec format_invalid_grant(term()) :: String.t()
  def format_invalid_grant(%{"error" => err, "error_description" => desc})
      when is_binary(err) and is_binary(desc) do
    "#{err}: #{desc}"
  end

  def format_invalid_grant(%{"error" => err}) when is_binary(err), do: err
  def format_invalid_grant(_body), do: "invalid_grant"

  defp record_terminal_error(message) do
    Store.put_settings_atomic([
      {"linear_oauth.refresh_status", "reconnect_required"},
      {"linear_oauth.last_refresh_error", message},
      {"linear_oauth.last_refresh_at", iso_now()}
    ])
  end

  defp record_transient_error(reason) do
    Store.put_settings_atomic([
      {"linear_oauth.refresh_status", "transient_error"},
      {"linear_oauth.last_refresh_error", inspect(reason)},
      {"linear_oauth.last_refresh_at", iso_now()}
    ])
  end

  # ── Scheduling ───────────────────────────────────────────────────────

  defp schedule_next(state) do
    state = cancel_timer(state)

    case next_refresh_delay_ms() do
      :no_token ->
        %{state | timer: nil}

      :reconnect_required ->
        Logger.info("Linear OAuth: refresh disabled, awaiting reconnect")
        %{state | timer: nil}

      {:ok, delay} ->
        timer = Process.send_after(self(), :refresh, delay)
        %{state | timer: timer}
    end
  end

  defp cancel_timer(%{timer: nil} = state), do: state

  defp cancel_timer(%{timer: timer} = state) do
    Process.cancel_timer(timer)
    %{state | timer: nil}
  end

  defp next_refresh_delay_ms do
    cond do
      Store.get_setting("linear_oauth.refresh_status") == "reconnect_required" ->
        :reconnect_required

      is_nil(Store.get_setting("linear_oauth.access_token")) ->
        :no_token

      true ->
        delay_for_expiry(Store.get_setting("linear_oauth.expires_at"))
    end
  end

  @doc false
  @spec delay_for_expiry(String.t() | nil) :: {:ok, non_neg_integer()} | :no_token
  def delay_for_expiry(nil), do: :no_token

  def delay_for_expiry(expires_at_str) when is_binary(expires_at_str) do
    case DateTime.from_iso8601(expires_at_str) do
      {:ok, expires_at, _} ->
        seconds_until = DateTime.diff(expires_at, DateTime.utc_now(), :second) - @refresh_buffer_seconds
        ms = max(seconds_until * 1000, 0)
        {:ok, min(ms, @max_schedule_ms)}

      _ ->
        :no_token
    end
  end

  defp iso_now do
    DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
  end
end
