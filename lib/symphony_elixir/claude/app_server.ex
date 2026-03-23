defmodule SymphonyElixir.Claude.AppServer do
  @moduledoc """
  Engine backend for Claude Code CLI.

  Speaks NDJSON over stdin/stdout with the Claude CLI running in
  `--output-format stream-json` mode. Each turn launches a fresh
  CLI process (single-shot execution).
  """

  @behaviour SymphonyElixir.Engine

  require Logger
  alias SymphonyElixir.{Claude.CommandBuilder, Claude.EventTranslator, Config, MCP.ConfigWriter}

  @port_line_bytes 1_048_576

  @type session :: %{
          workspace: Path.t(),
          worker_host: String.t() | nil,
          metadata: map()
        }

  @impl SymphonyElixir.Engine
  @spec start_session(Path.t(), keyword()) :: {:ok, session()} | {:error, term()}
  def start_session(workspace, opts \\ []) do
    worker_host = Keyword.get(opts, :worker_host)

    case validate_workspace(workspace, worker_host) do
      {:ok, expanded} ->
        {:ok,
         %{
           workspace: expanded,
           worker_host: worker_host,
           metadata: %{}
         }}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @impl SymphonyElixir.Engine
  @spec run_turn(session(), String.t(), map(), keyword()) :: {:ok, map()} | {:error, term()}
  def run_turn(session, prompt, _issue, opts \\ []) do
    on_message = Keyword.get(opts, :on_message, &default_on_message/1)
    workspace = session.workspace
    claude_config = Config.settings!().claude
    timeout_ms = claude_config.turn_timeout_ms

    with {:ok, mcp_config_path} <- write_mcp_config(workspace),
         command <- CommandBuilder.build(claude_config, mcp_config_path, prompt),
         {:ok, port} <- start_port(command, workspace, session.worker_host) do
      try do
        await_completion(port, on_message, timeout_ms)
      after
        safe_close_port(port)
      end
    end
  end

  @impl SymphonyElixir.Engine
  @spec stop_session(session()) :: :ok
  def stop_session(_session), do: :ok

  # -- Port management --

  defp start_port(command, workspace, nil) do
    port =
      Port.open(
        {:spawn, "bash -c #{shell_escape(command)}"},
        [
          :binary,
          :exit_status,
          :stderr_to_stdout,
          {:cd, workspace},
          {:line, @port_line_bytes},
          {:env, env_vars()}
        ]
      )

    {:ok, port}
  rescue
    e -> {:error, {:port_start_failed, Exception.message(e)}}
  end

  defp start_port(_command, _workspace, worker_host) do
    {:error, {:ssh_not_supported, "Claude engine does not yet support SSH worker hosts: #{worker_host}"}}
  end

  defp safe_close_port(port) do
    if Port.info(port) != nil do
      Port.close(port)
    end
  rescue
    ArgumentError -> :ok
  end

  defp await_completion(port, on_message, timeout_ms) do
    await_completion(port, on_message, timeout_ms, "", nil)
  end

  defp await_completion(port, on_message, timeout_ms, buffer, result) do
    receive do
      {^port, {:data, {:eol, line}}} ->
        full_line = buffer <> line
        result = process_line(full_line, on_message, result)
        await_completion(port, on_message, timeout_ms, "", result)

      {^port, {:data, {:noeol, chunk}}} ->
        await_completion(port, on_message, timeout_ms, buffer <> chunk, result)

      {^port, {:exit_status, 0}} ->
        finalize_result(result)

      {^port, {:exit_status, status}} ->
        if result do
          finalize_result(result)
        else
          {:error, {:claude_exit, status}}
        end
    after
      timeout_ms ->
        safe_close_port(port)
        {:error, :turn_timeout}
    end
  end

  defp process_line("", _on_message, result), do: result

  defp process_line(line, on_message, result) do
    case Jason.decode(line) do
      {:ok, decoded} ->
        events = EventTranslator.translate(decoded)

        Enum.each(events, fn event ->
          emit(on_message, event)
        end)

        case decoded do
          %{"type" => "result"} -> decoded
          _ -> result
        end

      {:error, _} ->
        Logger.debug("Claude NDJSON parse error: #{String.slice(line, 0, 200)}")
        result
    end
  end

  defp finalize_result(nil) do
    {:error, :no_result_message}
  end

  defp finalize_result(%{"type" => "result", "is_error" => true} = msg) do
    errors = Map.get(msg, "errors", [])
    {:error, {:claude_error, Map.get(msg, "subtype", "unknown"), errors}}
  end

  defp finalize_result(%{"type" => "result"} = msg) do
    usage = Map.get(msg, "usage", %{})

    {:ok,
     %{
       result: :turn_completed,
       session_id: Map.get(msg, "session_id", ""),
       thread_id: Map.get(msg, "session_id", ""),
       turn_id: Map.get(msg, "uuid", ""),
       total_cost_usd: Map.get(msg, "total_cost_usd"),
       duration_ms: Map.get(msg, "duration_ms"),
       num_turns: Map.get(msg, "num_turns"),
       usage: %{
         input_tokens: Map.get(usage, "input_tokens", 0),
         output_tokens: Map.get(usage, "output_tokens", 0),
         total_tokens: Map.get(usage, "input_tokens", 0) + Map.get(usage, "output_tokens", 0)
       }
     }}
  end

  # -- Helpers --

  defp write_mcp_config(workspace) do
    settings = Config.settings!()
    api_key = settings.tracker.api_key
    oauth_token = SymphonyElixir.Linear.OAuth.current_access_token()
    endpoint = settings.tracker.endpoint

    ConfigWriter.write(workspace, api_key: api_key, oauth_token: oauth_token, endpoint: endpoint)
  end

  defp validate_workspace(workspace, nil) when is_binary(workspace) do
    expanded = Path.expand(workspace)

    if File.dir?(expanded) do
      {:ok, expanded}
    else
      {:error, {:invalid_workspace, :not_a_directory, expanded}}
    end
  end

  defp validate_workspace(workspace, _worker_host) when is_binary(workspace) do
    {:ok, workspace}
  end

  defp validate_workspace(_, _), do: {:error, :invalid_workspace}

  defp env_vars do
    case SymphonyElixir.Settings.current_project() do
      %{env_vars: env_text} ->
        env_text
        |> SymphonyElixir.Settings.parse_env_vars()
        |> Enum.map(fn {k, v} -> {String.to_charlist(k), String.to_charlist(v)} end)

      _ ->
        []
    end
  rescue
    _ -> []
  end

  defp emit(on_message, event) when is_function(on_message, 1) do
    on_message.(event)
  end

  defp default_on_message(_event), do: :ok

  defp shell_escape(value) do
    "'" <> String.replace(value, "'", "'\\''") <> "'"
  end
end
