defmodule SymphonyElixir do
  @moduledoc """
  Entry point for the Symphony orchestrator.
  """

  @doc """
  Start the orchestrator in the current BEAM node.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    workflow_name = Keyword.get(opts, :workflow_name, SymphonyElixir.Workflow.default_workflow_name())
    SymphonyElixir.Orchestrator.start_link(Keyword.put(opts, :workflow_name, workflow_name))
  end
end

defmodule SymphonyElixir.Application do
  @moduledoc """
  OTP application entrypoint that starts core supervisors and workers.
  """

  use Application

  @impl true
  def start(_type, _args) do
    :ok = SymphonyElixir.LogFile.configure()
    ensure_db_directory()

    children =
      [
        {Phoenix.PubSub, name: SymphonyElixir.PubSub},
        {Registry, keys: :unique, name: SymphonyElixir.SessionLogRegistry},
        {Registry, keys: :unique, name: SymphonyElixir.OrchestratorRegistry},
        {Registry, keys: :unique, name: SymphonyElixir.AgentSessionRegistry},
        SymphonyElixir.Repo,
        SymphonyElixir.Store.Migrator,
        {Task.Supervisor, name: SymphonyElixir.TaskSupervisor},
        SymphonyElixir.WorkflowStore,
        {DynamicSupervisor, name: SymphonyElixir.OrchestratorSupervisor, strategy: :one_for_one},
        SymphonyElixir.OrchestratorStarter,
        SymphonyElixir.HttpServer,
        SymphonyElixir.StatusDashboard
      ]

    Supervisor.start_link(
      children,
      strategy: :one_for_one,
      name: SymphonyElixir.Supervisor
    )
  end

  @impl true
  def stop(_state) do
    SymphonyElixir.StatusDashboard.render_offline_status()
    :ok
  end

  defp ensure_db_directory do
    case Application.get_env(:symphony_elixir, SymphonyElixir.Repo)[:database] do
      path when is_binary(path) -> path |> Path.dirname() |> File.mkdir_p!()
      _ -> :ok
    end
  end
end
