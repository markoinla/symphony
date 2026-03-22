defmodule SymphonyElixir.AgentSession do
  @moduledoc """
  Manages a Linear Agent Session for one issue.

  Bridges engine events to Linear Agent Activities, maintains the Agent Plan,
  and handles mid-run user prompts via a pending queue.
  """

  use GenServer
  require Logger

  alias SymphonyElixir.Linear.{ActivityMapper, AgentAPI, PlanBuilder}

  @registry SymphonyElixir.AgentSessionRegistry
  @min_activity_interval_ms 500

  defmodule State do
    @moduledoc false

    @type t :: %__MODULE__{
            issue_id: String.t(),
            agent_session_id: String.t(),
            plan: [map()],
            pending_prompts: :queue.queue(String.t()),
            external_urls: [map()],
            dispatch_source: :webhook | :orchestrator,
            last_activity_at: integer()
          }

    defstruct [
      :issue_id,
      :agent_session_id,
      plan: [],
      pending_prompts: :queue.new(),
      external_urls: [],
      dispatch_source: :orchestrator,
      last_activity_at: 0
    ]
  end

  # -- Public API --

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    issue_id = Keyword.fetch!(opts, :issue_id)
    GenServer.start_link(__MODULE__, opts, name: via(issue_id))
  end

  @spec active?(String.t() | nil) :: boolean()
  def active?(issue_id) when is_binary(issue_id) do
    case Registry.lookup(@registry, issue_id) do
      [{_pid, _value}] -> true
      [] -> false
    end
  end

  def active?(_issue_id), do: false

  @spec emit_activity(String.t(), map()) :: :ok
  def emit_activity(issue_id, engine_event) when is_binary(issue_id) and is_map(engine_event) do
    case ActivityMapper.map_event(engine_event) do
      nil ->
        :ok

      content ->
        safe_cast(issue_id, {:emit_activity, content})
    end
  end

  @spec update_plan(String.t(), [map()]) :: :ok
  def update_plan(issue_id, plan_steps) when is_binary(issue_id) and is_list(plan_steps) do
    safe_cast(issue_id, {:update_plan, plan_steps})
  end

  @spec inject_prompt(String.t(), String.t()) :: :ok
  def inject_prompt(issue_id, message) when is_binary(issue_id) and is_binary(message) do
    safe_cast(issue_id, {:inject_prompt, message})
  end

  @spec drain_pending_prompts(String.t()) :: [String.t()]
  def drain_pending_prompts(issue_id) when is_binary(issue_id) do
    case Registry.lookup(@registry, issue_id) do
      [{pid, _value}] -> GenServer.call(pid, :drain_pending_prompts)
      [] -> []
    end
  end

  @spec set_external_urls(String.t(), [map()]) :: :ok
  def set_external_urls(issue_id, urls) when is_binary(issue_id) and is_list(urls) do
    safe_cast(issue_id, {:set_external_urls, urls})
  end

  @spec get_agent_session_id(String.t()) :: String.t() | nil
  def get_agent_session_id(issue_id) when is_binary(issue_id) do
    case Registry.lookup(@registry, issue_id) do
      [{pid, _value}] -> GenServer.call(pid, :get_agent_session_id)
      [] -> nil
    end
  end

  @spec stop(String.t()) :: :ok
  def stop(issue_id) when is_binary(issue_id) do
    case Registry.lookup(@registry, issue_id) do
      [{pid, _value}] -> GenServer.stop(pid, :normal)
      [] -> :ok
    end
  end

  # -- GenServer callbacks --

  @impl true
  def init(opts) do
    issue_id = Keyword.fetch!(opts, :issue_id)
    agent_session_id = Keyword.fetch!(opts, :agent_session_id)
    dispatch_source = Keyword.get(opts, :dispatch_source, :orchestrator)

    state = %State{
      issue_id: issue_id,
      agent_session_id: agent_session_id,
      plan: [],
      dispatch_source: dispatch_source,
      last_activity_at: System.monotonic_time(:millisecond) - @min_activity_interval_ms
    }

    Logger.info("AgentSession started issue_id=#{issue_id} agent_session_id=#{agent_session_id}")

    {:ok, state}
  end

  def handle_info({:deferred_activity, content}, state) do
    now = System.monotonic_time(:millisecond)
    do_emit_activity(state.agent_session_id, content)
    {:noreply, %{state | last_activity_at: now}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_cast({:emit_activity, content}, state) do
    now = System.monotonic_time(:millisecond)
    elapsed = now - state.last_activity_at

    if elapsed >= @min_activity_interval_ms do
      do_emit_activity(state.agent_session_id, content)
      {:noreply, %{state | last_activity_at: now}}
    else
      # Schedule deferred emission
      Process.send_after(self(), {:deferred_activity, content}, @min_activity_interval_ms - elapsed)
      {:noreply, state}
    end
  end

  def handle_cast({:update_plan, plan_steps}, state) do
    state = %{state | plan: plan_steps}
    do_update_plan(state)
    {:noreply, state}
  end

  def handle_cast({:inject_prompt, message}, state) do
    state = %{state | pending_prompts: :queue.in(message, state.pending_prompts)}
    {:noreply, state}
  end

  def handle_cast({:set_external_urls, urls}, state) do
    do_set_external_urls(state.agent_session_id, urls)
    {:noreply, %{state | external_urls: urls}}
  end

  @impl true
  def handle_call(:drain_pending_prompts, _from, state) do
    prompts = :queue.to_list(state.pending_prompts)
    {:reply, prompts, %{state | pending_prompts: :queue.new()}}
  end

  def handle_call(:get_agent_session_id, _from, state) do
    {:reply, state.agent_session_id, state}
  end

  # -- Internal --

  defp do_emit_activity(agent_session_id, content) do
    case AgentAPI.create_activity(agent_session_id, content) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to emit agent activity: #{inspect(reason)}")
    end
  end

  defp do_update_plan(state) do
    case AgentAPI.update_session(state.agent_session_id, plan: state.plan) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to update agent plan: #{inspect(reason)}")
    end
  end

  defp do_set_external_urls(agent_session_id, urls) do
    case AgentAPI.update_session(agent_session_id, added_external_urls: urls) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to set external URLs: #{inspect(reason)}")
    end
  end

  defp safe_cast(issue_id, message) do
    case Registry.lookup(@registry, issue_id) do
      [{pid, _value}] -> GenServer.cast(pid, message)
      [] -> :ok
    end
  end

  defp via(issue_id) do
    {:via, Registry, {@registry, issue_id}}
  end
end
