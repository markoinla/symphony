defmodule SymphonyElixir.AgentSession do
  @moduledoc """
  Per-issue GenServer that bridges engine events to Linear Agent Activities
  and manages the Agent Plan.

  Registered via `SymphonyElixir.AgentSessionRegistry`, keyed by `issue_id`.
  """

  use GenServer

  require Logger

  alias SymphonyElixir.Linear.AgentAPI

  @rate_limit_ms 500

  # ── Public API ──────────────────────────────────────────────────────

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    issue_id = Keyword.fetch!(opts, :issue_id)
    agent_session_id = Keyword.fetch!(opts, :agent_session_id)
    dispatch_source = Keyword.get(opts, :dispatch_source)
    name = via(issue_id)
    init_arg = {issue_id, agent_session_id, dispatch_source}
    GenServer.start_link(__MODULE__, init_arg, name: name)
  end

  @doc """
  Sends an activity to Linear via AgentAPI. Rate-limited to #{@rate_limit_ms}ms minimum
  between emissions; activities arriving faster are buffered and flushed on the next tick.
  """
  @spec emit_activity(String.t(), AgentAPI.activity_content()) :: :ok
  def emit_activity(issue_id, content) when is_binary(issue_id) and is_map(content) do
    case lookup(issue_id) do
      nil -> :ok
      pid -> GenServer.cast(pid, {:emit_activity, content})
    end
  end

  @doc """
  Sends the full plan array to Linear via AgentAPI.
  """
  @spec update_plan(String.t(), list()) :: :ok
  def update_plan(issue_id, plan_steps) when is_binary(issue_id) and is_list(plan_steps) do
    case lookup(issue_id) do
      nil -> :ok
      pid -> GenServer.cast(pid, {:update_plan, plan_steps})
    end
  end

  @doc """
  Enqueues a user message for the next turn boundary.
  """
  @spec inject_prompt(String.t(), String.t()) :: :ok
  def inject_prompt(issue_id, message) when is_binary(issue_id) and is_binary(message) do
    case lookup(issue_id) do
      nil -> :ok
      pid -> GenServer.cast(pid, {:inject_prompt, message})
    end
  end

  @doc """
  Returns and clears all queued prompt messages.
  """
  @spec drain_pending_prompts(String.t()) :: [String.t()]
  def drain_pending_prompts(issue_id) when is_binary(issue_id) do
    case lookup(issue_id) do
      nil -> []
      pid -> GenServer.call(pid, :drain_pending_prompts)
    end
  end

  @doc """
  Updates the external URLs on the Linear agent session.
  """
  @spec set_external_urls(String.t(), [String.t()]) :: :ok
  def set_external_urls(issue_id, urls) when is_binary(issue_id) and is_list(urls) do
    case lookup(issue_id) do
      nil -> :ok
      pid -> GenServer.cast(pid, {:set_external_urls, urls})
    end
  end

  @doc """
  Stops the AgentSession for the given issue.
  """
  @spec stop(String.t()) :: :ok
  def stop(issue_id) when is_binary(issue_id) do
    case lookup(issue_id) do
      nil -> :ok
      pid -> GenServer.stop(pid, :normal)
    end
  end

  @doc """
  Checks if an AgentSession is active for the given issue.
  """
  @spec active?(String.t()) :: boolean()
  def active?(issue_id) when is_binary(issue_id) do
    lookup(issue_id) != nil
  end

  # ── GenServer callbacks ─────────────────────────────────────────────

  @impl true
  def init({issue_id, agent_session_id, dispatch_source}) do
    state = %{
      issue_id: issue_id,
      agent_session_id: agent_session_id,
      plan: [],
      pending_prompts: :queue.new(),
      external_urls: [],
      dispatch_source: dispatch_source,
      activity_buffer: :queue.new(),
      last_emit_at: nil,
      flush_timer: nil
    }

    Logger.info("AgentSession started for issue_id=#{issue_id} agent_session_id=#{agent_session_id}")

    {:ok, state}
  end

  @impl true
  def handle_cast({:emit_activity, content}, state) do
    state = enqueue_activity(content, state)
    state = maybe_flush_activities(state)
    {:noreply, state}
  end

  @impl true
  def handle_cast({:update_plan, plan_steps}, state) do
    encoded = encode_plan(plan_steps)

    Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
      AgentAPI.update_session(state.agent_session_id, plan: encoded)
    end)

    {:noreply, %{state | plan: plan_steps}}
  end

  @impl true
  def handle_cast({:inject_prompt, message}, state) do
    {:noreply, %{state | pending_prompts: :queue.in(message, state.pending_prompts)}}
  end

  @impl true
  def handle_cast({:set_external_urls, urls}, state) do
    Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
      AgentAPI.update_session(state.agent_session_id, external_urls: urls)
    end)

    {:noreply, %{state | external_urls: urls}}
  end

  @impl true
  def handle_call(:drain_pending_prompts, _from, state) do
    messages = :queue.to_list(state.pending_prompts)
    {:reply, messages, %{state | pending_prompts: :queue.new()}}
  end

  @impl true
  def handle_info(:flush_activities, state) do
    state = %{state | flush_timer: nil}
    state = flush_one_activity(state)
    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ── Rate limiting ───────────────────────────────────────────────────

  defp enqueue_activity(content, state) do
    %{state | activity_buffer: :queue.in(content, state.activity_buffer)}
  end

  defp maybe_flush_activities(state) do
    now = System.monotonic_time(:millisecond)

    cond do
      # No timer pending and rate limit passed — flush immediately
      state.flush_timer == nil && can_emit?(state.last_emit_at, now) ->
        flush_one_activity(state)

      # Timer already scheduled — do nothing, it will flush
      state.flush_timer != nil ->
        state

      # Rate limited — schedule flush for remaining time
      true ->
        remaining = remaining_wait(state.last_emit_at, now)
        timer = Process.send_after(self(), :flush_activities, remaining)
        %{state | flush_timer: timer}
    end
  end

  defp flush_one_activity(state) do
    case :queue.out(state.activity_buffer) do
      {{:value, content}, rest} ->
        now = System.monotonic_time(:millisecond)

        Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
          AgentAPI.create_activity(state.agent_session_id, content)
        end)

        new_state = %{state | activity_buffer: rest, last_emit_at: now}

        # If more items buffered, schedule next flush
        if :queue.is_empty(rest) do
          new_state
        else
          timer = Process.send_after(self(), :flush_activities, @rate_limit_ms)
          %{new_state | flush_timer: timer}
        end

      {:empty, _} ->
        state
    end
  end

  defp can_emit?(nil, _now), do: true
  defp can_emit?(last, now), do: now - last >= @rate_limit_ms

  defp remaining_wait(nil, _now), do: 0
  defp remaining_wait(last, now), do: max(0, @rate_limit_ms - (now - last))

  # ── Helpers ─────────────────────────────────────────────────────────

  defp encode_plan(plan_steps) when is_list(plan_steps) do
    plan_steps
    |> Enum.map(fn
      %{title: title, status: status} ->
        %{"title" => title, "status" => to_string(status)}

      step when is_map(step) ->
        Map.new(step, fn {k, v} -> {to_string(k), to_string(v)} end)
    end)
    |> Jason.encode!()
  end

  defp via(issue_id) do
    {:via, Registry, {SymphonyElixir.AgentSessionRegistry, issue_id}}
  end

  defp lookup(issue_id) do
    case Registry.lookup(SymphonyElixir.AgentSessionRegistry, issue_id) do
      [{pid, _}] -> pid
      [] -> nil
    end
  end
end
