defmodule SymphonyElixir.SessionLog do
  @moduledoc """
  Per-session conversation log capturing filtered Codex messages.

  One process per active session, registered via Registry keyed by
  `{issue_id, session_id}`. Receives all Codex events from the
  `on_message` callback and stores only conversation-relevant ones.
  """

  use GenServer

  require Logger

  alias SymphonyElixir.Store
  alias SymphonyElixirWeb.ObservabilityPubSub

  @max_content_bytes 102_400

  # ── Public API ──────────────────────────────────────────────────────

  @type message :: %{
          id: pos_integer(),
          timestamp: DateTime.t(),
          type: :response | :tool_call | :thinking | :reasoning_summary | :turn_boundary | :error,
          content: String.t(),
          metadata: map()
        }

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    issue_id = Keyword.fetch!(opts, :issue_id)
    session_id = Keyword.fetch!(opts, :session_id)
    issue_identifier = Keyword.get(opts, :issue_identifier)
    issue_title = Keyword.get(opts, :issue_title)
    project_id = Keyword.get(opts, :project_id)
    organization_id = Keyword.get(opts, :organization_id)
    config_snapshot = Keyword.get(opts, :config_snapshot)
    workflow_name = Keyword.get(opts, :workflow_name)
    github_branch = Keyword.get(opts, :github_branch)
    name = via(issue_id, session_id)

    init_arg =
      {issue_id, session_id, issue_identifier, issue_title, project_id, organization_id, config_snapshot, workflow_name, github_branch}

    GenServer.start_link(__MODULE__, init_arg, name: name)
  end

  @spec append(String.t(), String.t(), map()) :: :ok
  def append(issue_id, session_id, engine_message) do
    case lookup(issue_id, session_id) do
      nil -> :ok
      pid -> GenServer.cast(pid, {:append, engine_message})
    end
  end

  @spec get_messages(String.t(), String.t()) :: {:ok, [message()]} | {:error, :not_found}
  def get_messages(issue_id, session_id) do
    case lookup(issue_id, session_id) do
      nil ->
        {:error, :not_found}

      pid ->
        db_session_id = GenServer.call(pid, :get_db_session_id)
        {:ok, load_messages(db_session_id)}
    end
  end

  defp load_messages(nil), do: []

  defp load_messages(db_session_id) do
    Store.get_session_messages(db_session_id)
    |> Enum.map(fn m ->
      %{
        id: m.seq,
        timestamp: m.timestamp,
        type: String.to_existing_atom(m.type),
        content: m.content,
        metadata: parse_metadata(m.metadata)
      }
    end)
  end

  @spec get_db_session_id(String.t(), String.t()) :: integer() | nil
  def get_db_session_id(issue_id, session_id) do
    case lookup(issue_id, session_id) do
      nil -> nil
      pid -> GenServer.call(pid, :get_db_session_id)
    end
  end

  @spec finalize(String.t(), String.t(), atom(), map()) :: :ok
  def finalize(issue_id, session_id, status, attrs) do
    case lookup(issue_id, session_id) do
      nil -> :ok
      pid -> GenServer.call(pid, {:finalize, status, attrs})
    end
  end

  @spec store_stderr(String.t(), String.t(), String.t()) :: :ok
  def store_stderr(issue_id, session_id, content) when is_binary(content) do
    case lookup(issue_id, session_id) do
      nil -> :ok
      pid -> GenServer.call(pid, {:store_stderr, content})
    end
  end

  @spec stop(String.t(), String.t()) :: :ok
  def stop(issue_id, session_id) do
    case lookup(issue_id, session_id) do
      nil -> :ok
      pid -> GenServer.stop(pid, :normal)
    end
  end

  # ── GenServer callbacks ─────────────────────────────────────────────

  @impl true
  def init({issue_id, session_id, issue_identifier, issue_title, project_id, organization_id, config_snapshot, workflow_name, github_branch}) do
    db_session_id =
      case Store.create_session(%{
             issue_id: issue_id,
             session_id: session_id,
             issue_identifier: issue_identifier,
             issue_title: issue_title,
             status: "running",
             started_at: DateTime.utc_now(),
             project_id: project_id,
             organization_id: organization_id,
             config_snapshot: config_snapshot,
             workflow_name: workflow_name,
             workflow: workflow_name,
             github_branch: github_branch
           }) do
        {:ok, session} ->
          session.id

        {:error, reason} ->
          Logger.warning("Failed to create DB session for issue_id=#{issue_id}: #{inspect(reason)}")
          nil
      end

    state = %{
      issue_id: issue_id,
      session_id: session_id,
      next_id: 1,
      db_session_id: db_session_id,
      last_streamable: nil,
      last_tool_call: nil
    }

    Logger.info("SessionLog started for issue_id=#{issue_id} session_id=#{session_id} db_session_id=#{inspect(db_session_id)}")
    {:ok, state}
  end

  @impl true
  def handle_cast({:append, engine_message}, state) do
    state = maybe_sync_engine_session_id(engine_message, state)

    case classify_message(engine_message) do
      nil ->
        {:noreply, state}

      :reset_stream ->
        {:noreply, %{state | last_streamable: nil}}

      {:stream, type, content, metadata, stream_key} ->
        handle_streamable_delta(type, content, metadata, engine_message, stream_key, state)

      {:message, :tool_call, tool_name, metadata} ->
        handle_tool_call(tool_name, metadata, engine_message, state)

      {:message, type, content, metadata} ->
        message = %{
          id: state.next_id,
          timestamp: Map.get(engine_message, :timestamp, DateTime.utc_now()),
          type: type,
          content: content,
          metadata: metadata
        }

        ObservabilityPubSub.broadcast_session_message(state.issue_id, message)
        persist_message(state.db_session_id, message)

        {:noreply, %{state | next_id: state.next_id + 1, last_streamable: nil, last_tool_call: nil}}
    end
  end

  @impl true
  def handle_call({:finalize, status, attrs}, _from, state) do
    if state.db_session_id do
      completion_attrs =
        attrs
        |> Map.put(:status, to_string(status))
        |> Map.put(:ended_at, DateTime.utc_now())
        |> maybe_put_estimated_cost()
        |> maybe_put_error_category(status)

      case Store.complete_session(state.db_session_id, completion_attrs) do
        {:ok, _session} ->
          :ok

        {:error, reason} ->
          Logger.warning("Failed to finalize DB session #{state.db_session_id}: #{inspect(reason)}")
      end
    end

    {:reply, :ok, state}
  end

  @impl true
  def handle_call({:store_stderr, content}, _from, state) do
    if state.db_session_id do
      case Store.update_session_stderr(state.db_session_id, content) do
        {:ok, _session} ->
          :ok

        {:error, reason} ->
          Logger.warning("Failed to store stderr for DB session #{state.db_session_id}: #{inspect(reason)}")
      end
    end

    {:reply, :ok, state}
  end

  @impl true
  def handle_call(:get_db_session_id, _from, state) do
    {:reply, state.db_session_id, state}
  end

  # ── Streamable delta aggregation ────────────────────────────────────

  # Aggregate consecutive deltas that belong to the same logical item.
  defp handle_streamable_delta(
         _type,
         content,
         _metadata,
         _engine_message,
         stream_key,
         %{last_streamable: %{stream_key: stream_key, message: last}} = state
       ) do
    updated = %{last | content: cap_content(last.content <> content)}

    ObservabilityPubSub.broadcast_session_message_update(state.issue_id, updated)
    update_persisted_message(state.db_session_id, updated)

    {:noreply, %{state | last_streamable: %{stream_key: stream_key, message: updated}}}
  end

  # First delta of this type — create a new message
  defp handle_streamable_delta(type, content, metadata, engine_message, stream_key, state) do
    message = %{
      id: state.next_id,
      timestamp: Map.get(engine_message, :timestamp, DateTime.utc_now()),
      type: type,
      content: content,
      metadata: metadata
    }

    ObservabilityPubSub.broadcast_session_message(state.issue_id, message)
    persist_message(state.db_session_id, message)

    {:noreply, %{state | next_id: state.next_id + 1, last_streamable: %{stream_key: stream_key, message: message}}}
  end

  # ── Tool call deduplication ──────────────────────────────────────────

  # Merge with existing tool_call if same tool_name (dedup duplicate events)
  defp handle_tool_call(
         tool_name,
         metadata,
         _engine_message,
         %{last_tool_call: %{content: last_name} = last} = state
       )
       when tool_name == last_name do
    merged = merge_tool_metadata(last.metadata, metadata)
    updated = %{last | metadata: merged}

    ObservabilityPubSub.broadcast_session_message_update(state.issue_id, updated)
    update_persisted_metadata(state.db_session_id, updated)

    {:noreply, %{state | last_tool_call: updated}}
  end

  # First tool_call event — create a new message
  defp handle_tool_call(tool_name, metadata, engine_message, state) do
    message = %{
      id: state.next_id,
      timestamp: Map.get(engine_message, :timestamp, DateTime.utc_now()),
      type: :tool_call,
      content: tool_name,
      metadata: metadata
    }

    ObservabilityPubSub.broadcast_session_message(state.issue_id, message)
    persist_message(state.db_session_id, message)

    {:noreply, %{state | next_id: state.next_id + 1, last_streamable: nil, last_tool_call: message}}
  end

  defp merge_tool_metadata(existing, incoming) do
    %{
      status: merge_tool_status(existing[:status], incoming[:status]),
      args: merge_tool_args(existing, incoming)
    }
    |> maybe_put_arg(:error, first_present(incoming[:error], existing[:error]))
    |> maybe_put_arg(:reason, first_present(incoming[:reason], existing[:reason]))
    |> maybe_put_arg(:decision, first_present(incoming[:decision], existing[:decision]))
  end

  defp merge_tool_args(existing, incoming) do
    Map.merge(tool_args(existing), tool_args(incoming))
  end

  defp tool_args(metadata) do
    case metadata[:args] do
      args when is_map(args) -> args
      _ -> %{}
    end
  end

  defp merge_tool_status(_existing_status, incoming_status)
       when incoming_status not in [nil, "unknown"],
       do: incoming_status

  defp merge_tool_status(existing_status, _incoming_status)
       when existing_status not in [nil, "unknown"],
       do: existing_status

  defp merge_tool_status(existing_status, incoming_status),
    do: incoming_status || existing_status || "unknown"

  defp first_present(primary, fallback), do: primary || fallback

  defp update_persisted_metadata(nil, _message), do: :ok

  defp update_persisted_metadata(db_session_id, message) do
    encoded = Jason.encode!(message.metadata)

    Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
      retry_update_message_metadata(db_session_id, message.id, encoded, 10)
    end)

    :ok
  end

  defp retry_update_message_metadata(_db_session_id, _seq, _metadata, 0), do: :ok

  defp retry_update_message_metadata(db_session_id, seq, metadata, attempts_left) do
    case Store.update_message_metadata(db_session_id, seq, metadata) do
      {:ok, _message} ->
        :ok

      {:error, :not_found} ->
        Process.sleep(10)
        retry_update_message_metadata(db_session_id, seq, metadata, attempts_left - 1)

      {:error, _reason} ->
        :ok
    end
  end

  # ── Message classification ──────────────────────────────────────────

  defp classify_message(%{event: :notification} = msg) do
    payload = Map.get(msg, :payload, %{})
    method = get_in_payload(payload, "method")
    classify_notification(payload, method)
  end

  defp classify_message(%{event: :tool_call_completed} = msg) do
    payload = Map.get(msg, :payload, %{})
    tool_name = extract_tool_name(payload)
    args = extract_tool_args(payload)
    {:message, :tool_call, tool_name || "unknown", %{args: args, status: "completed"}}
  end

  defp classify_message(%{event: :tool_call_failed} = msg) do
    payload = Map.get(msg, :payload, %{})
    tool_name = extract_tool_name(payload)
    error = extract_error(payload)
    {:message, :tool_call, tool_name || "unknown", %{args: %{}, status: "failed", error: error}}
  end

  defp classify_message(%{event: :turn_completed}) do
    {:message, :turn_boundary, "Turn completed", %{status: "completed"}}
  end

  defp classify_message(%{event: :turn_failed} = msg) do
    reason = extract_failure_reason(msg)
    {:message, :error, "Turn failed: #{reason}", %{status: "failed", reason: reason}}
  end

  defp classify_message(%{event: :turn_cancelled}) do
    {:message, :turn_boundary, "Turn cancelled", %{status: "cancelled"}}
  end

  defp classify_message(_msg), do: nil

  # ── Notification classification ─────────────────────────────────────

  defp classify_notification(_payload, method)
       when method in ["initialize", "thread/start", "session/start", "claude/init"],
       do: nil

  defp classify_notification(payload, method) do
    classify_stream_boundary(payload, method) ||
      classify_by_method(payload, method) ||
      classify_by_content_blocks(payload)
  end

  # Codex wrapper events: agent message streaming
  defp classify_by_method(payload, "codex/event/agent_message_delta"),
    do: wrap_streamable(:response, extract_wrapper_delta(payload), payload)

  defp classify_by_method(payload, "codex/event/agent_message_content_delta"),
    do: wrap_streamable(:response, extract_wrapper_content(payload), payload)

  defp classify_by_method(payload, "item/agentMessage/delta"),
    do: wrap_streamable(:response, payload_path(payload, ["params", "delta"]), payload)

  # Codex wrapper events: reasoning summary streaming
  defp classify_by_method(payload, "codex/event/agent_reasoning"),
    do: wrap_streamable(:reasoning_summary, extract_wrapper_reasoning(payload), payload)

  defp classify_by_method(payload, "item/reasoning/summaryTextDelta"),
    do: wrap_streamable(:reasoning_summary, payload_path(payload, ["params", "summaryText"]), payload)

  # Codex wrapper events: reasoning/thinking streaming
  defp classify_by_method(payload, "codex/event/agent_reasoning_delta"),
    do: wrap_streamable(:thinking, extract_wrapper_delta(payload), payload)

  defp classify_by_method(payload, "codex/event/reasoning_content_delta"),
    do: wrap_streamable(:thinking, extract_wrapper_delta(payload), payload)

  defp classify_by_method(payload, "item/reasoning/textDelta"),
    do: wrap_streamable(:thinking, payload_path(payload, ["params", "textDelta"]), payload)

  # Exec command completion (wrapper format)
  defp classify_by_method(payload, "codex/event/exec_command_end"),
    do: wrap_exec_command_end(payload)

  # MCP tool call completion (wrapper format)
  defp classify_by_method(payload, "codex/event/mcp_tool_call_end"),
    do: wrap_mcp_tool_call(payload, "completed")

  # Non-streamable item/completed falls through from classify_stream_boundary
  defp classify_by_method(payload, method)
       when method in ["item/completed", "codex/event/item_completed"],
       do: classify_item_tool_call(payload, "completed")

  # Claude Code events: assistant message streaming
  defp classify_by_method(payload, "claude/assistant_message"),
    do: wrap_streamable(:response, payload_path(payload, ["params", "content"]), payload)

  # Claude Code events: thinking streaming
  defp classify_by_method(payload, "claude/thinking"),
    do: wrap_streamable(:thinking, payload_path(payload, ["params", "content"]), payload)

  # Claude Code events: tool use notification
  defp classify_by_method(payload, "claude/tool_use") do
    tool_name = payload_path(payload, ["params", "name"]) || "unknown"
    {:message, :tool_call, tool_name, %{status: "started"}}
  end

  # Claude Code events: tool result
  defp classify_by_method(payload, "claude/tool_result") do
    is_error = payload_path(payload, ["params", "is_error"])
    tool_id = payload_path(payload, ["params", "tool_use_id"]) || "unknown"
    status = if is_error, do: "failed", else: "completed"
    {:message, :tool_call, tool_id, %{status: status}}
  end

  defp classify_by_method(_payload, _method), do: nil

  defp wrap_streamable(type, text, payload) when is_binary(text) and text != "" do
    {:stream, type, text, %{}, stream_key(type, payload)}
  end

  defp wrap_streamable(_type, _text, _payload), do: nil

  defp wrap_exec_command_end(payload) do
    exit_code = extract_exec_exit_code(payload)
    status = if exit_code == 0, do: "completed", else: "failed"

    args =
      %{}
      |> maybe_put_arg(:cmd, extract_exec_command(payload))
      |> maybe_put_arg(:exit_code, exit_code)

    {:message, :tool_call, "exec_command", %{args: args, status: status}}
  end

  defp wrap_mcp_tool_call(payload, status) do
    tool_name = extract_wrapper_tool_name(payload) || "mcp_tool"
    {:message, :tool_call, tool_name, %{args: %{}, status: status}}
  end

  defp classify_item_tool_call(payload, status) do
    item_type = extract_item_type(payload)

    case item_type do
      type when type in ["commandExecution", "command_execution"] ->
        args =
          %{}
          |> maybe_put_arg(:cmd, extract_item_command(payload))
          |> maybe_put_arg(:cwd, extract_item_cwd(payload))

        {:message, :tool_call, "exec_command", %{args: args, status: status}}

      type when type in ["fileChange", "file_change"] ->
        {:message, :tool_call, "apply_patch", %{args: %{}, status: status}}

      _ ->
        nil
    end
  end

  # Fallback: content-block format (standard API responses)
  defp classify_by_content_blocks(payload) when is_map(payload) do
    params = Map.get(payload, "params", %{})

    cond do
      has_text_content?(params) -> {:message, :response, extract_text_content(params), %{}}
      has_thinking_content?(params) -> {:message, :thinking, extract_thinking_content(params), %{}}
      true -> nil
    end
  end

  defp classify_by_content_blocks(_payload), do: nil

  defp classify_stream_boundary(payload, method)
       when method in ["item/completed", "codex/event/item_completed"] do
    if streamable_item_type?(extract_completed_item_type(payload)), do: :reset_stream, else: nil
  end

  defp classify_stream_boundary(_payload, _method), do: nil

  # ── Payload extraction helpers ──────────────────────────────────────

  defp get_in_payload(payload, key) when is_map(payload), do: Map.get(payload, key)
  defp get_in_payload(_payload, _key), do: nil

  defp payload_path(payload, keys) when is_map(payload) do
    Enum.reduce_while(keys, payload, fn key, acc ->
      case acc do
        map when is_map(map) -> {:cont, Map.get(map, key)}
        _ -> {:halt, nil}
      end
    end)
  end

  defp payload_path(_payload, _keys), do: nil

  defp extract_wrapper_delta(payload) do
    payload_path(payload, ["params", "msg", "payload", "delta"]) ||
      payload_path(payload, ["params", "msg", "delta"])
  end

  defp extract_wrapper_content(payload) do
    case payload_path(payload, ["params", "msg", "content"]) ||
           payload_path(payload, ["params", "msg", "payload", "content"]) do
      text when is_binary(text) and text != "" -> text
      _ -> nil
    end
  end

  defp extract_wrapper_reasoning(payload) do
    payload_path(payload, ["params", "msg", "payload", "summaryText"]) ||
      payload_path(payload, ["params", "msg", "summaryText"])
  end

  defp extract_exec_command(payload) do
    payload_path(payload, ["params", "msg", "command"]) ||
      payload_path(payload, ["params", "msg", "parsed_cmd"]) ||
      payload_path(payload, ["params", "msg", "parsedCmd"]) ||
      payload_path(payload, ["params", "command"]) ||
      payload_path(payload, ["params", "parsedCmd"]) ||
      payload_path(payload, ["params", "parsed_cmd"])
  end

  defp extract_exec_cwd(payload) do
    payload_path(payload, ["params", "msg", "cwd"]) ||
      payload_path(payload, ["params", "cwd"])
  end

  defp extract_exec_exit_code(payload) do
    payload_path(payload, ["params", "msg", "exit_code"]) ||
      payload_path(payload, ["params", "msg", "exitCode"]) ||
      payload_path(payload, ["params", "exit_code"]) ||
      payload_path(payload, ["params", "exitCode"])
  end

  defp extract_wrapper_tool_name(payload) do
    payload_path(payload, ["params", "msg", "tool"]) ||
      payload_path(payload, ["params", "msg", "name"]) ||
      payload_path(payload, ["params", "msg", "payload", "tool"]) ||
      payload_path(payload, ["params", "msg", "payload", "name"]) ||
      payload_path(payload, ["params", "tool"]) ||
      payload_path(payload, ["params", "name"])
  end

  defp extract_item_type(payload) do
    payload_path(payload, ["params", "item", "type"]) ||
      payload_path(payload, ["params", "msg", "payload", "type"]) ||
      payload_path(payload, ["params", "msg", "type"])
  end

  defp extract_item_command(payload) do
    payload_path(payload, ["params", "item", "command"]) ||
      payload_path(payload, ["params", "item", "parsed_cmd"]) ||
      payload_path(payload, ["params", "item", "parsedCmd"]) ||
      extract_exec_command(payload)
  end

  defp extract_item_cwd(payload) do
    payload_path(payload, ["params", "item", "cwd"]) ||
      extract_exec_cwd(payload)
  end

  defp extract_completed_item_type(payload) do
    payload_path(payload, ["params", "item", "type"]) ||
      payload_path(payload, ["params", "msg", "payload", "type"])
  end

  defp has_text_content?(params) when is_map(params) do
    cond do
      is_binary(Map.get(params, "content")) and Map.get(params, "content") != "" -> true
      is_binary(Map.get(params, "text")) and Map.get(params, "text") != "" -> true
      content_blocks_have_type?(params, "text") -> true
      true -> false
    end
  end

  defp has_text_content?(_params), do: false

  defp extract_text_content(params) when is_map(params) do
    cond do
      is_binary(Map.get(params, "content")) ->
        Map.get(params, "content")

      is_binary(Map.get(params, "text")) ->
        Map.get(params, "text")

      is_list(Map.get(params, "content")) ->
        Map.get(params, "content")
        |> Enum.filter(&(is_map(&1) and &1["type"] == "text"))
        |> Enum.map_join("\n", & &1["text"])

      true ->
        ""
    end
  end

  defp has_thinking_content?(params) when is_map(params) do
    content_blocks_have_type?(params, "thinking")
  end

  defp has_thinking_content?(_params), do: false

  defp extract_thinking_content(params) when is_map(params) do
    case Map.get(params, "content") do
      blocks when is_list(blocks) ->
        blocks
        |> Enum.filter(&(is_map(&1) and &1["type"] == "thinking"))
        |> Enum.map_join("\n", & &1["thinking"])

      _ ->
        ""
    end
  end

  defp content_blocks_have_type?(params, type) when is_map(params) do
    case Map.get(params, "content") do
      blocks when is_list(blocks) ->
        Enum.any?(blocks, fn
          %{"type" => ^type} -> true
          _ -> false
        end)

      _ ->
        false
    end
  end

  defp extract_tool_name(payload) when is_map(payload) do
    params = Map.get(payload, "params", %{})
    result = Map.get(payload, "result", %{}) || %{}

    Map.get(params, "tool") ||
      Map.get(params, "name") ||
      Map.get(result, "tool") ||
      Map.get(result, "name")
  end

  defp extract_tool_name(_payload), do: nil

  defp extract_tool_args(payload) when is_map(payload) do
    params = Map.get(payload, "params", %{})
    result = Map.get(payload, "result", %{}) || %{}

    args = Map.get(params, "arguments") || Map.get(result, "arguments") || %{}

    case args do
      a when is_map(a) -> summarize_args(a)
      _ -> %{}
    end
  end

  defp extract_tool_args(_payload), do: %{}

  defp summarize_args(args) when is_map(args) do
    Map.new(args, fn {k, v} ->
      {k, summarize_value(v)}
    end)
  end

  defp summarize_value(v) when is_binary(v) and byte_size(v) > 200 do
    String.slice(v, 0, 200) <> "..."
  end

  defp summarize_value(v), do: v

  defp extract_error(payload) when is_map(payload) do
    result = Map.get(payload, "result", %{}) || %{}
    Map.get(result, "error") || Map.get(result, "message") || "unknown error"
  end

  defp extract_error(_payload), do: "unknown error"

  defp stream_key(type, payload) do
    case extract_stream_id(payload) do
      nil -> {:stream, type}
      item_id -> {:stream, type, item_id}
    end
  end

  defp extract_stream_id(payload) do
    first_payload_path(payload, [
      ["params", "itemId"],
      ["params", "item_id"],
      ["params", "id"],
      ["params", "item", "id"],
      ["params", "msg", "id"],
      ["params", "msg", "itemId"],
      ["params", "msg", "item_id"],
      ["params", "msg", "payload", "id"],
      ["params", "msg", "payload", "itemId"],
      ["params", "msg", "payload", "item_id"]
    ])
  end

  defp streamable_item_type?(type) when is_binary(type) do
    normalized =
      type
      |> String.replace(~r/([a-z0-9])([A-Z])/, "\\1_\\2")
      |> String.downcase()

    normalized in ["agent_message", "reasoning", "reasoning_summary"]
  end

  defp streamable_item_type?(_type), do: false

  defp maybe_put_arg(map, _key, nil), do: map
  defp maybe_put_arg(map, key, value), do: Map.put(map, key, value)

  defp first_payload_path(payload, keys_list) do
    Enum.find_value(keys_list, &payload_path(payload, &1))
  end

  defp extract_failure_reason(%{details: %{reason: reason}}) when is_binary(reason), do: reason

  defp extract_failure_reason(%{payload: %{"params" => %{"error" => error}}}) when is_binary(error),
    do: error

  defp extract_failure_reason(%{payload: %{"params" => params}}) when is_map(params),
    do: inspect(params)

  defp extract_failure_reason(_msg), do: "unknown"

  # ── Cost estimation ───────────────────────────────────────────────────

  defp maybe_put_estimated_cost(%{estimated_cost_cents: _} = attrs), do: attrs

  defp maybe_put_estimated_cost(attrs) do
    input_tokens = Map.get(attrs, :input_tokens, 0)
    output_tokens = Map.get(attrs, :output_tokens, 0)

    model =
      try do
        SymphonyElixir.Config.settings!().claude.model
      rescue
        _ -> nil
      end

    cost =
      if is_binary(model) do
        SymphonyElixir.Pricing.cost_cents(model, input_tokens, output_tokens)
      else
        Logger.warning("Model name unavailable at session finalization, defaulting estimated_cost_cents to 0")
        0
      end

    Map.put(attrs, :estimated_cost_cents, cost)
  end

  # ── Error category ────────────────────────────────────────────────────

  defp maybe_put_error_category(%{error_category: _} = attrs, _status), do: attrs

  defp maybe_put_error_category(attrs, :failed) do
    Logger.warning(
      "Session finalized as failed without error_category, defaulting to infra — " <>
        "this indicates a code path that doesn't classify errors"
    )

    Map.put(attrs, :error_category, "infra")
  end

  defp maybe_put_error_category(attrs, _status) do
    Map.put(attrs, :error_category, nil)
  end

  # ── Helpers ─────────────────────────────────────────────────────────

  defp persist_message(nil, _message), do: :ok

  defp persist_message(db_session_id, message) do
    Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
      Store.append_message(db_session_id, %{
        seq: message.id,
        type: to_string(message.type),
        content: message.content,
        metadata: Jason.encode!(message.metadata),
        timestamp: message.timestamp
      })
    end)

    :ok
  end

  defp update_persisted_message(nil, _message), do: :ok

  defp update_persisted_message(db_session_id, message) do
    Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
      retry_update_message_content(db_session_id, message.id, message.content, 10)
    end)

    :ok
  end

  defp retry_update_message_content(_db_session_id, _seq, _content, 0), do: :ok

  defp retry_update_message_content(db_session_id, seq, content, attempts_left) do
    case Store.update_message_content(db_session_id, seq, content) do
      {:ok, _message} ->
        :ok

      {:error, :not_found} ->
        Process.sleep(10)
        retry_update_message_content(db_session_id, seq, content, attempts_left - 1)

      {:error, _reason} ->
        :ok
    end
  end

  # When the real codex session_id arrives via :session_started, update the DB
  # session so that finalize_db_session (which looks up by codex session_id)
  # can find and update it with turn_count / total_tokens.
  # This is synchronous (not async) to ensure the DB session_id is updated
  # before any subsequent token sync attempts that look up by engine session_id.
  defp maybe_sync_engine_session_id(
         %{event: :session_started, session_id: engine_session_id},
         %{db_session_id: db_id} = state
       )
       when is_binary(engine_session_id) and not is_nil(db_id) do
    Store.update_session_engine_id(db_id, engine_session_id)
    state
  end

  defp maybe_sync_engine_session_id(_msg, state), do: state

  defp cap_content(content) when byte_size(content) > @max_content_bytes do
    truncated_size = @max_content_bytes - 14

    binary_part(content, byte_size(content) - truncated_size, truncated_size)
    |> then(&("[truncated]…\n" <> &1))
  end

  defp cap_content(content), do: content

  defp parse_metadata(nil), do: %{}

  defp parse_metadata(json) when is_binary(json) do
    case Jason.decode(json) do
      {:ok, map} when is_map(map) -> atomize_known_keys(map)
      _ -> %{}
    end
  end

  defp parse_metadata(map) when is_map(map), do: map
  defp parse_metadata(_), do: %{}

  @known_metadata_keys %{
    "status" => :status,
    "args" => :args,
    "error" => :error,
    "reason" => :reason,
    "decision" => :decision
  }

  defp atomize_known_keys(map) when is_map(map) do
    Map.new(map, fn {k, v} ->
      {Map.get(@known_metadata_keys, k, k), v}
    end)
  end

  defp via(issue_id, session_id) do
    {:via, Registry, {SymphonyElixir.SessionLogRegistry, {issue_id, session_id}}}
  end

  defp lookup(issue_id, session_id) do
    case Registry.lookup(SymphonyElixir.SessionLogRegistry, {issue_id, session_id}) do
      [{pid, _}] -> pid
      [] -> nil
    end
  end
end
