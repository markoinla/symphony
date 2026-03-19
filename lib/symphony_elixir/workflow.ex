defmodule SymphonyElixir.Workflow do
  @moduledoc """
  Loads workflow configuration and prompt from WORKFLOW.md.
  """

  alias SymphonyElixir.WorkflowStore

  @workflow_file_name "WORKFLOW.md"
  @workflow_name_key :symphony_workflow_name

  @spec workflow_file_path() :: Path.t()
  def workflow_file_path do
    workflow_file_paths()
    |> List.first()
  end

  @spec set_workflow_file_path(Path.t()) :: :ok
  def set_workflow_file_path(path) when is_binary(path) do
    expanded_path = Path.expand(path)
    Application.put_env(:symphony_elixir, :workflow_file_path, expanded_path)
    Application.put_env(:symphony_elixir, :workflow_file_paths, [expanded_path])
    maybe_reload_store()
    :ok
  end

  @spec workflow_file_paths() :: [Path.t()]
  def workflow_file_paths do
    case Application.get_env(:symphony_elixir, :workflow_file_paths) do
      paths when is_list(paths) and paths != [] ->
        Enum.map(paths, &Path.expand/1)

      _ ->
        [
          Application.get_env(:symphony_elixir, :workflow_file_path) ||
            Path.join(File.cwd!(), @workflow_file_name)
        ]
        |> Enum.map(&Path.expand/1)
    end
  end

  @spec set_workflow_file_paths([Path.t()]) :: :ok
  def set_workflow_file_paths(paths) when is_list(paths) do
    expanded_paths =
      paths
      |> Enum.map(&Path.expand/1)
      |> Enum.reject(&(&1 == ""))
      |> Enum.uniq()

    case expanded_paths do
      [] ->
        clear_workflow_file_path()

      [default_path | _] ->
        Application.put_env(:symphony_elixir, :workflow_file_path, default_path)
        Application.put_env(:symphony_elixir, :workflow_file_paths, expanded_paths)
        maybe_reload_store()
        :ok
    end
  end

  @spec workflow_names() :: [String.t()]
  def workflow_names do
    named_workflow_paths()
    |> Enum.map(fn {workflow_name, _path} -> workflow_name end)
  end

  @spec named_workflow_paths() :: [{String.t(), Path.t()}]
  def named_workflow_paths do
    Enum.map(workflow_file_paths(), fn path -> {workflow_name(path), path} end)
  end

  @spec workflow_name(Path.t()) :: String.t()
  def workflow_name(path) when is_binary(path) do
    path
    |> Path.basename()
    |> Path.rootname()
  end

  @spec default_workflow_name() :: String.t()
  def default_workflow_name do
    workflow_file_path()
    |> workflow_name()
  end

  @spec current_workflow_name() :: String.t()
  def current_workflow_name do
    Process.get(@workflow_name_key) || default_workflow_name()
  end

  @spec put_current_workflow_name(String.t()) :: :ok
  def put_current_workflow_name(workflow_name) when is_binary(workflow_name) do
    Process.put(@workflow_name_key, workflow_name)
    :ok
  end

  @spec clear_current_workflow_name() :: :ok
  def clear_current_workflow_name do
    Process.delete(@workflow_name_key)
    :ok
  end

  @spec with_workflow(String.t(), (-> term())) :: term()
  def with_workflow(workflow_name, fun) when is_binary(workflow_name) and is_function(fun, 0) do
    previous = Process.get(@workflow_name_key)
    put_current_workflow_name(workflow_name)

    try do
      fun.()
    after
      case previous do
        value when is_binary(value) -> Process.put(@workflow_name_key, value)
        _ -> Process.delete(@workflow_name_key)
      end
    end
  end

  @spec clear_workflow_file_path() :: :ok
  def clear_workflow_file_path do
    Application.delete_env(:symphony_elixir, :workflow_file_path)
    Application.delete_env(:symphony_elixir, :workflow_file_paths)
    maybe_reload_store()
    :ok
  end

  @type loaded_workflow :: %{
          config: map(),
          prompt: String.t(),
          prompt_template: String.t()
        }

  @spec current() :: {:ok, loaded_workflow()} | {:error, term()}
  def current do
    current(current_workflow_name())
  end

  @spec current(String.t()) :: {:ok, loaded_workflow()} | {:error, term()}
  def current(workflow_name) when is_binary(workflow_name) do
    case Process.whereis(WorkflowStore) do
      pid when is_pid(pid) ->
        WorkflowStore.current(workflow_name)

      _ ->
        load_by_name(workflow_name)
    end
  end

  @spec load() :: {:ok, loaded_workflow()} | {:error, term()}
  def load do
    load(workflow_file_path())
  end

  @spec load(Path.t()) :: {:ok, loaded_workflow()} | {:error, term()}
  def load(path) when is_binary(path) do
    case File.read(path) do
      {:ok, content} ->
        parse(content)

      {:error, reason} ->
        {:error, {:missing_workflow_file, path, reason}}
    end
  end

  @spec load_by_name(String.t()) :: {:ok, loaded_workflow()} | {:error, term()}
  def load_by_name(workflow_name) when is_binary(workflow_name) do
    case path_for_workflow(workflow_name) do
      {:ok, path} -> load(path)
      {:error, reason} -> {:error, reason}
    end
  end

  @spec path_for_workflow(String.t()) :: {:ok, Path.t()} | {:error, term()}
  def path_for_workflow(workflow_name) when is_binary(workflow_name) do
    case Enum.find(named_workflow_paths(), fn {name, _path} -> name == workflow_name end) do
      {_name, path} ->
        {:ok, path}

      nil ->
        {:error, {:unknown_workflow, workflow_name}}
    end
  end

  defp parse(content) do
    {front_matter_lines, prompt_lines} = split_front_matter(content)

    case front_matter_yaml_to_map(front_matter_lines) do
      {:ok, front_matter} ->
        prompt = Enum.join(prompt_lines, "\n") |> String.trim()

        {:ok,
         %{
           config: front_matter,
           prompt: prompt,
           prompt_template: prompt
         }}

      {:error, :workflow_front_matter_not_a_map} ->
        {:error, :workflow_front_matter_not_a_map}

      {:error, reason} ->
        {:error, {:workflow_parse_error, reason}}
    end
  end

  defp split_front_matter(content) do
    lines = String.split(content, ~r/\R/, trim: false)

    case lines do
      ["---" | tail] ->
        {front, rest} = Enum.split_while(tail, &(&1 != "---"))

        case rest do
          ["---" | prompt_lines] -> {front, prompt_lines}
          _ -> {front, []}
        end

      _ ->
        {[], lines}
    end
  end

  defp front_matter_yaml_to_map(lines) do
    yaml = Enum.join(lines, "\n")

    if String.trim(yaml) == "" do
      {:ok, %{}}
    else
      case YamlElixir.read_from_string(yaml) do
        {:ok, decoded} when is_map(decoded) -> {:ok, decoded}
        {:ok, _} -> {:error, :workflow_front_matter_not_a_map}
        {:error, reason} -> {:error, reason}
      end
    end
  end

  defp maybe_reload_store do
    if Process.whereis(WorkflowStore) do
      _ = WorkflowStore.force_reload()
    end

    :ok
  end
end
