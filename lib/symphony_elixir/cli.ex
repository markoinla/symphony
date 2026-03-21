defmodule SymphonyElixir.CLI do
  @moduledoc """
  Escript entrypoint for running Symphony with an explicit WORKFLOW.md path.
  """

  alias SymphonyElixir.LogFile

  @acknowledgement_switch :i_understand_that_this_will_be_running_without_the_usual_guardrails
  @switches [{@acknowledgement_switch, :boolean}, logs_root: :string, port: :integer, workflows: :string]

  @type ensure_started_result :: {:ok, [atom()]} | {:error, term()}
  @type deps :: %{
          file_regular?: (String.t() -> boolean()),
          file_dir?: (String.t() -> boolean()),
          set_workflow_file_paths: ([String.t()] -> :ok | {:error, term()}),
          set_logs_root: (String.t() -> :ok | {:error, term()}),
          set_server_port_override: (non_neg_integer() | nil -> :ok | {:error, term()}),
          ensure_all_started: (-> ensure_started_result())
        }

  @spec main([String.t()]) :: no_return()
  def main(args) do
    case evaluate(args) do
      :ok ->
        wait_for_shutdown()

      {:error, message} ->
        IO.puts(:stderr, message)
        System.halt(1)
    end
  end

  @spec evaluate([String.t()], deps()) :: :ok | {:error, String.t()}
  def evaluate(args, deps \\ runtime_deps()) do
    case OptionParser.parse(args, strict: @switches) do
      {opts, workflow_args, []} ->
        with :ok <- require_guardrails_acknowledgement(opts),
             :ok <- maybe_set_logs_root(opts, deps),
             :ok <- maybe_set_server_port(opts, deps),
             {:ok, workflow_paths} <- resolve_workflow_paths(opts, workflow_args, deps) do
          run(workflow_paths, deps)
        end

      _ ->
        {:error, usage_message()}
    end
  end

  @spec run([String.t()], deps()) :: :ok | {:error, String.t()}
  def run(workflow_paths, deps) when is_list(workflow_paths) do
    expanded_paths =
      workflow_paths
      |> Enum.map(&Path.expand/1)
      |> Enum.uniq()

    case Enum.find(expanded_paths, fn path -> not deps.file_regular?.(path) end) do
      nil ->
        :ok = set_workflow_paths(deps, expanded_paths)
        ensure_nif_code_paths()

        case deps.ensure_all_started.() do
          {:ok, _started_apps} ->
            :ok

          {:error, reason} ->
            {:error, "Failed to start Symphony with workflows #{Enum.join(expanded_paths, ", ")}: #{inspect(reason)}"}
        end

      missing_path ->
        {:error, "Workflow file not found: #{missing_path}"}
    end
  end

  @spec usage_message() :: String.t()
  defp usage_message do
    "Usage: symphony [--logs-root <path>] [--port <port>] [--workflows <dir-or-file>] [path-to-WORKFLOW.md ...]"
  end

  @spec runtime_deps() :: deps()
  defp runtime_deps do
    %{
      file_regular?: &File.regular?/1,
      file_dir?: &File.dir?/1,
      set_workflow_file_paths: &SymphonyElixir.Workflow.set_workflow_file_paths/1,
      set_logs_root: &set_logs_root/1,
      set_server_port_override: &set_server_port_override/1,
      ensure_all_started: fn -> Application.ensure_all_started(:symphony_elixir) end
    }
  end

  defp resolve_workflow_paths(opts, workflow_args, deps) do
    explicit_paths =
      opts
      |> Keyword.get_values(:workflows)
      |> Enum.reduce_while([], fn value, acc ->
        case expand_workflow_argument(value, deps) do
          {:ok, paths} -> {:cont, acc ++ paths}
          {:error, reason} -> {:halt, {:error, reason}}
        end
      end)

    case explicit_paths do
      {:error, reason} ->
        {:error, reason}

      paths ->
        resolved_paths =
          case workflow_args ++ paths do
            [] -> [Path.expand("WORKFLOW.md")]
            values -> Enum.map(values, &Path.expand/1)
          end

        if resolved_paths == [] do
          {:error, usage_message()}
        else
          {:ok, resolved_paths}
        end
    end
  end

  defp expand_workflow_argument(value, deps) when is_binary(value) do
    expanded = Path.expand(value)

    cond do
      deps.file_regular?.(expanded) ->
        {:ok, [expanded]}

      deps.file_dir?.(expanded) ->
        workflow_paths =
          expanded
          |> Path.join("*.md")
          |> Path.wildcard()
          |> Enum.filter(fn path -> deps.file_regular?.(path) end)
          |> Enum.sort()

        case workflow_paths do
          [] -> {:error, "No workflow files found in directory: #{expanded}"}
          paths -> {:ok, paths}
        end

      true ->
        {:error, "Workflow path not found: #{expanded}"}
    end
  end

  defp set_workflow_paths(%{set_workflow_file_paths: setter}, workflow_paths)
       when is_function(setter, 1) do
    setter.(workflow_paths)
  end

  defp set_workflow_paths(%{set_workflow_file_path: setter}, [workflow_path])
       when is_function(setter, 1) do
    setter.(workflow_path)
  end

  defp set_workflow_paths(_deps, workflow_paths) do
    {:error, "Unable to configure workflows #{Enum.join(workflow_paths, ", ")}: runtime deps missing workflow setter"}
  end

  defp maybe_set_logs_root(opts, deps) do
    case Keyword.get_values(opts, :logs_root) do
      [] ->
        :ok

      values ->
        logs_root = values |> List.last() |> String.trim()

        if logs_root == "" do
          {:error, usage_message()}
        else
          :ok = deps.set_logs_root.(Path.expand(logs_root))
        end
    end
  end

  defp require_guardrails_acknowledgement(opts) do
    if Keyword.get(opts, @acknowledgement_switch, false) do
      :ok
    else
      {:error, acknowledgement_banner()}
    end
  end

  @spec acknowledgement_banner() :: String.t()
  defp acknowledgement_banner do
    lines = [
      "This Symphony implementation is a low key engineering preview.",
      "Codex will run without any guardrails.",
      "SymphonyElixir is not a supported product and is presented as-is.",
      "To proceed, start with `--i-understand-that-this-will-be-running-without-the-usual-guardrails` CLI argument"
    ]

    width = Enum.max(Enum.map(lines, &String.length/1))
    border = String.duplicate("─", width + 2)
    top = "╭" <> border <> "╮"
    bottom = "╰" <> border <> "╯"
    spacer = "│ " <> String.duplicate(" ", width) <> " │"

    content =
      [
        top,
        spacer
        | Enum.map(lines, fn line ->
            "│ " <> String.pad_trailing(line, width) <> " │"
          end)
      ] ++ [spacer, bottom]

    [
      IO.ANSI.red(),
      IO.ANSI.bright(),
      Enum.join(content, "\n"),
      IO.ANSI.reset()
    ]
    |> IO.iodata_to_binary()
  end

  defp set_logs_root(logs_root) do
    Application.put_env(:symphony_elixir, :log_file, LogFile.default_log_file(logs_root))
    :ok
  end

  defp maybe_set_server_port(opts, deps) do
    case Keyword.get_values(opts, :port) do
      [] ->
        :ok

      values ->
        port = List.last(values)

        if is_integer(port) and port >= 0 do
          :ok = deps.set_server_port_override.(port)
        else
          {:error, usage_message()}
        end
    end
  end

  defp set_server_port_override(port) when is_integer(port) and port >= 0 do
    Application.put_env(:symphony_elixir, :server_port_override, port)
    :ok
  end

  # In escript context, NIF priv dirs are not embedded in the archive.
  # Replace the exqlite code path so :code.priv_dir(:exqlite) resolves
  # to the real _build directory containing sqlite3_nif.so.
  # Also fix :code.priv_dir(:symphony_elixir) so the SPA controller
  # can find built dashboard assets under priv/static/dashboard/.
  defp ensure_nif_code_paths do
    for app <- [:exqlite, :symphony_elixir] do
      build_ebin = Path.expand("_build/dev/lib/#{app}/ebin")

      if File.dir?(build_ebin) do
        case :code.lib_dir(app) do
          {:error, :bad_name} -> :ok
          lib_dir -> :code.del_path(~c"#{lib_dir}/ebin")
        end

        :code.add_patha(String.to_charlist(build_ebin))
      end
    end

    :ok
  end

  @spec wait_for_shutdown() :: no_return()
  defp wait_for_shutdown do
    case Process.whereis(SymphonyElixir.Supervisor) do
      nil ->
        IO.puts(:stderr, "Symphony supervisor is not running")
        System.halt(1)

      pid ->
        ref = Process.monitor(pid)

        receive do
          {:DOWN, ^ref, :process, ^pid, reason} ->
            case reason do
              :normal -> System.halt(0)
              _ -> System.halt(1)
            end
        end
    end
  end
end
