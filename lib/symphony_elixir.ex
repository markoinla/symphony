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
    run_migrations()

    children =
      [
        {Phoenix.PubSub, name: SymphonyElixir.PubSub},
        {Registry, keys: :unique, name: SymphonyElixir.SessionLogRegistry},
        {Registry, keys: :unique, name: SymphonyElixir.OrchestratorRegistry},
        {Registry, keys: :unique, name: SymphonyElixir.AgentSessionRegistry},
        SymphonyElixir.Repo,
        {Task.Supervisor, name: SymphonyElixir.TaskSupervisor},
        SymphonyElixir.WorkflowStore,
        {DynamicSupervisor, name: SymphonyElixir.OrchestratorSupervisor, strategy: :one_for_one}
      ] ++ runtime_children()

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

  defp runtime_children do
    if sandbox_pool?() do
      []
    else
      [
        SymphonyElixir.OrchestratorStarter,
        SymphonyElixir.HttpServer,
        SymphonyElixir.StatusDashboard
      ]
    end
  end

  defp run_migrations do
    unless sandbox_pool?() do
      {:ok, _, _} =
        Ecto.Migrator.with_repo(SymphonyElixir.Repo, &Ecto.Migrator.run(&1, :up, all: true))
    end
  end

  defp sandbox_pool? do
    repo_config = Application.get_env(:symphony_elixir, SymphonyElixir.Repo, [])
    repo_config[:pool] == Ecto.Adapters.SQL.Sandbox
  end
end
