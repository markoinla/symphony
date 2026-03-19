defmodule SymphonyElixir.WorkflowStore do
  @moduledoc """
  Caches the last known good workflow set and reloads each entry when its file changes.
  """

  use GenServer
  require Logger

  alias SymphonyElixir.Workflow

  @poll_interval_ms 1_000

  defmodule State do
    @moduledoc false

    defstruct [:path, :stamp, :workflow, workflows: %{}]
  end

  defmodule Entry do
    @moduledoc false

    defstruct [:path, :stamp, :workflow]
  end

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @spec current() :: {:ok, Workflow.loaded_workflow()} | {:error, term()}
  def current do
    current(Workflow.current_workflow_name())
  end

  @spec current(String.t()) :: {:ok, Workflow.loaded_workflow()} | {:error, term()}
  def current(workflow_name) when is_binary(workflow_name) do
    case Process.whereis(__MODULE__) do
      pid when is_pid(pid) ->
        GenServer.call(__MODULE__, {:current, workflow_name})

      _ ->
        Workflow.load_by_name(workflow_name)
    end
  end

  @spec all() :: {:ok, %{optional(String.t()) => Workflow.loaded_workflow()}} | {:error, term()}
  def all do
    case Process.whereis(__MODULE__) do
      pid when is_pid(pid) ->
        GenServer.call(__MODULE__, :all)

      _ ->
        load_all_from_disk()
    end
  end

  @spec workflow_names() :: [String.t()]
  def workflow_names do
    case all() do
      {:ok, workflows} -> Map.keys(workflows)
      {:error, _reason} -> Workflow.workflow_names()
    end
  end

  @spec force_reload() :: :ok | {:error, term()}
  def force_reload do
    case Process.whereis(__MODULE__) do
      pid when is_pid(pid) ->
        GenServer.call(__MODULE__, :force_reload)

      _ ->
        case load_state(Workflow.named_workflow_paths()) do
          {:ok, _state} -> :ok
          {:error, reason} -> {:error, reason}
        end
    end
  end

  @impl true
  def init(_opts) do
    case load_state(Workflow.named_workflow_paths()) do
      {:ok, state} ->
        schedule_poll()
        {:ok, state}

      {:error, reason} ->
        {:stop, reason}
    end
  end

  @impl true
  def handle_call({:current, workflow_name}, _from, %State{} = state) do
    case reload_state(state) do
      {:ok, new_state} ->
        {:reply, fetch_workflow(new_state, workflow_name), new_state}

      {:error, _reason, new_state} ->
        {:reply, fetch_workflow(new_state, workflow_name), new_state}
    end
  end

  def handle_call(:all, _from, %State{} = state) do
    case reload_state(state) do
      {:ok, new_state} ->
        {:reply, {:ok, export_workflows(new_state)}, new_state}

      {:error, _reason, new_state} ->
        {:reply, {:ok, export_workflows(new_state)}, new_state}
    end
  end

  def handle_call(:force_reload, _from, %State{} = state) do
    case reload_state(state) do
      {:ok, new_state} ->
        {:reply, :ok, new_state}

      {:error, reason, new_state} ->
        {:reply, {:error, reason}, new_state}
    end
  end

  @impl true
  def handle_info(:poll, %State{} = state) do
    schedule_poll()

    case reload_state(state) do
      {:ok, new_state} -> {:noreply, new_state}
      {:error, _reason, new_state} -> {:noreply, new_state}
    end
  end

  defp schedule_poll do
    Process.send_after(self(), :poll, @poll_interval_ms)
  end

  defp reload_state(%State{} = state) do
    reload_named_paths(Workflow.named_workflow_paths(), state)
  end

  defp reload_named_paths([], %State{} = state) do
    {:error, :no_workflows_configured, state}
  end

  defp reload_named_paths(named_paths, %State{} = state) do
    {workflows, errors} =
      Enum.reduce(named_paths, {%{}, []}, fn {workflow_name, path}, {workflows, errors} ->
        case reload_entry(workflow_name, path, state) do
          {:ok, entry} ->
            {Map.put(workflows, workflow_name, entry), errors}

          {:error, reason, %Entry{} = entry} ->
            {Map.put(workflows, workflow_name, entry), [{path, reason} | errors]}

          {:error, reason, nil} ->
            {workflows, [{path, reason} | errors]}
        end
      end)

    new_state = build_state(workflows)

    case errors do
      [] ->
        {:ok, new_state}

      [{path, reason} | _rest] ->
        log_reload_error(path, reason)

        if map_size(workflows) == 0 do
          {:error, reason, state}
        else
          {:error, reason, build_state(workflows)}
        end
    end
  end

  defp reload_entry(workflow_name, path, %State{} = state) do
    case Map.get(state.workflows, workflow_name) do
      %Entry{path: ^path} = entry ->
        reload_current_entry(path, entry)

      %Entry{} = entry ->
        reload_path(path, entry)

      nil ->
        case load_entry(path) do
          {:ok, loaded_entry} -> {:ok, loaded_entry}
          {:error, reason} -> {:error, reason, nil}
        end
    end
  end

  defp reload_path(path, %Entry{} = entry) do
    case load_entry(path) do
      {:ok, new_entry} ->
        {:ok, new_entry}

      {:error, reason} ->
        log_reload_error(path, reason)
        {:error, reason, entry}
    end
  end

  defp reload_current_entry(path, %Entry{} = entry) do
    case current_stamp(path) do
      {:ok, stamp} when stamp == entry.stamp ->
        {:ok, entry}

      {:ok, _stamp} ->
        reload_path(path, entry)

      {:error, reason} ->
        log_reload_error(path, reason)
        {:error, reason, entry}
    end
  end

  defp load_state(named_paths) when is_list(named_paths) do
    named_paths
    |> Enum.reduce_while({:ok, %{}}, fn {workflow_name, path}, {:ok, workflows} ->
      case load_entry(path) do
        {:ok, entry} ->
          {:cont, {:ok, Map.put(workflows, workflow_name, entry)}}

        {:error, reason} ->
          {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, workflows} when map_size(workflows) > 0 -> {:ok, build_state(workflows)}
      {:ok, _empty_workflows} -> {:error, :no_workflows_configured}
      {:error, reason} -> {:error, reason}
    end
  end

  defp load_entry(path) do
    with {:ok, workflow} <- Workflow.load(path),
         {:ok, stamp} <- current_stamp(path) do
      {:ok, %Entry{path: path, stamp: stamp, workflow: workflow}}
    else
      {:error, reason} -> {:error, reason}
    end
  end

  defp current_stamp(path) when is_binary(path) do
    with {:ok, stat} <- File.stat(path, time: :posix),
         {:ok, content} <- File.read(path) do
      {:ok, {stat.mtime, stat.size, :erlang.phash2(content)}}
    else
      {:error, reason} -> {:error, reason}
    end
  end

  defp log_reload_error(path, reason) do
    Logger.error("Failed to reload workflow path=#{path} reason=#{inspect(reason)}; keeping last known good configuration")
  end

  defp fetch_workflow(%State{} = state, workflow_name) when is_binary(workflow_name) do
    case Map.get(state.workflows, workflow_name) do
      %Entry{workflow: workflow} ->
        {:ok, workflow}

      nil ->
        {:error, {:unknown_workflow, workflow_name}}
    end
  end

  defp export_workflows(%State{} = state) do
    Map.new(state.workflows, fn {workflow_name, %Entry{workflow: workflow}} ->
      {workflow_name, workflow}
    end)
  end

  defp load_all_from_disk do
    Workflow.named_workflow_paths()
    |> Enum.reduce_while({:ok, %{}}, fn {workflow_name, path}, {:ok, workflows} ->
      case Workflow.load(path) do
        {:ok, workflow} -> {:cont, {:ok, Map.put(workflows, workflow_name, workflow)}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp build_state(workflows) when is_map(workflows) do
    default_workflow_name = Workflow.default_workflow_name()
    default_entry = Map.get(workflows, default_workflow_name) || workflows |> Map.values() |> List.first()

    %State{
      path: default_entry && default_entry.path,
      stamp: default_entry && default_entry.stamp,
      workflow: default_entry && default_entry.workflow,
      workflows: workflows
    }
  end
end
