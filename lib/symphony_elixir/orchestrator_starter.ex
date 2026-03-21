defmodule SymphonyElixir.OrchestratorStarter do
  @moduledoc """
  Ensures orchestrators are running under the OrchestratorSupervisor.

  Monitors the DynamicSupervisor and re-creates orchestrators when it restarts
  (e.g. after a child exceeded the restart limit). Also periodically reconciles
  to cover edge cases where an orchestrator dies without triggering a supervisor
  restart.
  """

  use GenServer
  require Logger

  @reconcile_interval_ms 30_000

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_opts) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @impl true
  def init(:ok) do
    Process.monitor(SymphonyElixir.OrchestratorSupervisor)
    SymphonyElixir.Store.clear_all_issue_claims()
    ensure_orchestrators()
    schedule_reconcile()
    {:ok, %{}}
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, _pid, _reason}, state) do
    # DynamicSupervisor crashed and will be restarted by the top-level supervisor.
    # Wait briefly for it to come back, then re-create orchestrators.
    Process.send_after(self(), :restart_orchestrators, 500)
    {:noreply, state}
  end

  @impl true
  def handle_info(:restart_orchestrators, state) do
    case Process.whereis(SymphonyElixir.OrchestratorSupervisor) do
      pid when is_pid(pid) ->
        Process.monitor(pid)
        ensure_orchestrators()

      nil ->
        # Not back yet, retry
        Process.send_after(self(), :restart_orchestrators, 500)
    end

    {:noreply, state}
  end

  @impl true
  def handle_info(:reconcile, state) do
    ensure_orchestrators()
    schedule_reconcile()
    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  defp schedule_reconcile do
    Process.send_after(self(), :reconcile, @reconcile_interval_ms)
  end

  defp ensure_orchestrators do
    projects = SymphonyElixir.Store.list_projects()

    SymphonyElixir.Workflow.named_workflow_paths()
    |> Enum.each(fn {workflow_name, path} ->
      if workflow_uses_project_filter?(path) and projects != [] do
        Enum.each(projects, fn project ->
          ensure_started(workflow_name: workflow_name, project_id: project.id)
        end)
      else
        ensure_started(workflow_name: workflow_name)
      end
    end)
  end

  defp ensure_started(opts) do
    workflow_name = Keyword.fetch!(opts, :workflow_name)
    project_id = Keyword.get(opts, :project_id)
    server = SymphonyElixir.Orchestrator.workflow_server(workflow_name, project_id)

    unless GenServer.whereis(server) do
      case DynamicSupervisor.start_child(
             SymphonyElixir.OrchestratorSupervisor,
             {SymphonyElixir.Orchestrator, opts}
           ) do
        {:ok, _pid} ->
          Logger.info("Started orchestrator #{workflow_name}:#{project_id || "default"}")

        {:error, {:already_started, _pid}} ->
          :ok

        {:error, reason} ->
          Logger.warning("Failed to start orchestrator #{workflow_name}:#{project_id || "default"}: #{inspect(reason)}")
      end
    end
  end

  defp workflow_uses_project_filter?(path) do
    case SymphonyElixir.Workflow.load(path) do
      {:ok, %{config: %{"tracker" => %{"filter_by" => "label"}}}} -> false
      _ -> true
    end
  end
end
