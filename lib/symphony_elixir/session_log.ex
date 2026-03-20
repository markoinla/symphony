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
    name = via(issue_id, session_id)
    init_arg = {issue_id, session_id, issue_identifier, issue_title, project_id}
    GenServer.start_link(__MODULE__, init_arg, name: name)
  end

  @spec append(String.t(), String.t(), map()) :: :ok
  def append(issue_id, session_id, codex_message) do
    case lookup(issue_id, session_id) do
      nil -> :ok
      pid -> GenServer.cast(pid, {:append, codex_message})
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

  @spec finalize(String.t(), String.t(), atom(), map()) :: :ok
  def finalize(issue_id, session_id, status, attrs) do
    case lookup(issue_id, session_id) do
      nil -> :ok
      pid -> GenServer.cast(pid, {:finalize, status, attrs})
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
  def init({issue_id, session_id, issue_identifier, issue_title, project_id}) do
    db_session_id =
      case Store.create_session(%{
             issue_id: issue_id,
             session_id: session_id,
             issue_identifier: issue_identifier,
             issue_title: issue_title,
             status: "running",
             started_at: DateTime.utc_now(),
             project_id: project_id
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
      last_streamable: nil
    }

    Logger.info("SessionLog started for issue_id=#{issue_id} session_id=#{session_id} db_session_id=#{inspect(db_session_id)}")
    {:ok, state}
  end

  # Types where consecutive deltas should be merged into a single message
  @streamable_types [:response, :thinking, :reasoning_summary]

  @impl true
  def handle_cast({:append, codex_message}, state) do
    state = maybe_sync_codex_session_id(codex_message, state)

    case classify_message(codex_message) do
      nil ->
        {:noreply, state}

      {type, content, metadata} when type in @streamable_types ->
        handle_streamable_delta(type, content, metadata, codex_message, state)

      {type, content, metadata} ->
        message = %{
          id: state.next_id,
          timestamp: Map.get(codex_message, :timestamp, DateTime.utc_now()),
          type: type,
          content: content,
          metadata: metadata
        }

        ObservabilityPubSub.broadcast_session_message(state.issue_id, message)
        persist_message(state.db_session_id, message)

        {:noreply, %{state | next_id: state.next_id + 1, last_streamable: nil}}
    end
  end

  @impl true
  def handle_cast({:finalize, status, attrs}, state) do
    if state.db_session_id do
      completion_attrs =
        attrs
        |> Map.put(:status, to_string(status))
        |> Map.put(:ended_at, DateTime.utc_now())

      case Store.complete_session(state.db_session_id, completion_attrs) do
        {:ok, _session} ->
          :ok

        {:error, reason} ->
          Logger.warning("Failed to finalize DB session #{state.db_session_id}: #{inspect(reason)}")
      end
    end

    {:noreply, state}
  end

  @impl true
  def handle_call(:get_db_session_id, _from, state) do
    {:reply, state.db_session_id, state}
  end

  # ── Streamable delta aggregation ────────────────────────────────────

  # Aggregate consecutive deltas of the same streamable type into the current message
  defp handle_streamable_delta(type, content, _metadata, _codex_message, %{last_streamable: %{type: type} = last} = state) do
    updated = %{last | content: cap_content(last.content <> content)}

    ObservabilityPubSub.broadcast_session_message_update(state.issue_id, updated)
    update_persisted_message(state.db_session_id, updated)

    {:noreply, %{state | last_streamable: updated}}
  end

  # First delta of this type — create a new message
  defp handle_streamable_delta(type, content, metadata, codex_message, state) do
    message = %{
      id: state.next_id,
      timestamp: Map.get(codex_message, :timestamp, DateTime.utc_now()),
      type: type,
      content: content,
      metadata: metadata
    }

    ObservabilityPubSub.broadcast_session_message(state.issue_id, message)
    persist_message(state.db_session_id, message)

    {:noreply, %{state | next_id: state.next_id + 1, last_streamable: message}}
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
    {:tool_call, tool_name || "unknown", %{args: args, status: "completed"}}
  end

  defp classify_message(%{event: :tool_call_failed} = msg) do
    payload = Map.get(msg, :payload, %{})
    tool_name = extract_tool_name(payload)
    error = extract_error(payload)
    {:tool_call, tool_name || "unknown", %{args: %{}, status: "failed", error: error}}
  end

  defp classify_message(%{event: :approval_auto_approved} = msg) do
    payload = Map.get(msg, :payload, %{})
    decision = Map.get(msg, :decision, "auto_approved")
    tool_name = extract_tool_name(payload)
    {:tool_call, tool_name || "auto_approved", %{decision: decision, status: "auto_approved"}}
  end

  defp classify_message(%{event: :turn_completed}) do
    {:turn_boundary, "Turn completed", %{status: "completed"}}
  end

  defp classify_message(%{event: :turn_failed} = msg) do
    reason = extract_failure_reason(msg)
    {:error, "Turn failed: #{reason}", %{status: "failed", reason: reason}}
  end

  defp classify_message(%{event: :turn_cancelled}) do
    {:turn_boundary, "Turn cancelled", %{status: "cancelled"}}
  end

  defp classify_message(_msg), do: nil

  # ── Notification classification ─────────────────────────────────────

  defp classify_notification(_payload, method)
       when method in ["initialize", "thread/start", "session/start"],
       do: nil

  defp classify_notification(payload, method) do
    classify_by_method(payload, method) || classify_by_content_blocks(payload)
  end

  # Codex wrapper events: agent message streaming
  defp classify_by_method(payload, "codex/event/agent_message_delta"),
    do: wrap_response(extract_wrapper_delta(payload))

  defp classify_by_method(payload, "codex/event/agent_message_content_delta"),
    do: wrap_response(extract_wrapper_content(payload))

  defp classify_by_method(payload, "item/agentMessage/delta"),
    do: wrap_response(payload_path(payload, ["params", "delta"]))

  # Codex wrapper events: reasoning summary streaming
  defp classify_by_method(payload, "codex/event/agent_reasoning"),
    do: wrap_reasoning_summary(extract_wrapper_reasoning(payload))

  defp classify_by_method(payload, "item/reasoning/summaryTextDelta"),
    do: wrap_reasoning_summary(payload_path(payload, ["params", "summaryText"]))

  # Codex wrapper events: reasoning/thinking streaming
  defp classify_by_method(payload, "codex/event/agent_reasoning_delta"),
    do: wrap_thinking(extract_wrapper_delta(payload))

  defp classify_by_method(payload, "codex/event/reasoning_content_delta"),
    do: wrap_thinking(extract_wrapper_delta(payload))

  defp classify_by_method(payload, "item/reasoning/textDelta"),
    do: wrap_thinking(payload_path(payload, ["params", "textDelta"]))

  defp classify_by_method(_payload, _method), do: nil

  defp wrap_response(text) when is_binary(text) and text != "", do: {:response, text, %{}}
  defp wrap_response(_), do: nil

  defp wrap_thinking(text) when is_binary(text) and text != "", do: {:thinking, text, %{}}
  defp wrap_thinking(_), do: nil

  defp wrap_reasoning_summary(text) when is_binary(text) and text != "", do: {:reasoning_summary, text, %{}}
  defp wrap_reasoning_summary(_), do: nil

  # Fallback: content-block format (standard API responses)
  defp classify_by_content_blocks(payload) when is_map(payload) do
    params = Map.get(payload, "params", %{})

    cond do
      has_text_content?(params) -> {:response, extract_text_content(params), %{}}
      has_thinking_content?(params) -> {:thinking, extract_thinking_content(params), %{}}
      true -> nil
    end
  end

  defp classify_by_content_blocks(_payload), do: nil

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

  defp extract_failure_reason(%{details: %{reason: reason}}) when is_binary(reason), do: reason

  defp extract_failure_reason(%{payload: %{"params" => %{"error" => error}}}) when is_binary(error),
    do: error

  defp extract_failure_reason(%{payload: %{"params" => params}}) when is_map(params),
    do: inspect(params)

  defp extract_failure_reason(_msg), do: "unknown"

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
      Store.update_message_content(db_session_id, message.id, message.content)
    end)

    :ok
  end

  # When the real codex session_id arrives via :session_started, update the DB
  # session so that finalize_db_session (which looks up by codex session_id)
  # can find and update it with turn_count / total_tokens.
  defp maybe_sync_codex_session_id(
         %{event: :session_started, session_id: codex_session_id},
         %{db_session_id: db_id} = state
       )
       when is_binary(codex_session_id) and not is_nil(db_id) do
    Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
      Store.update_session_codex_id(db_id, codex_session_id)
    end)

    state
  end

  defp maybe_sync_codex_session_id(_msg, state), do: state

  defp cap_content(content) when byte_size(content) > @max_content_bytes do
    truncated_size = @max_content_bytes - 14

    binary_part(content, byte_size(content) - truncated_size, truncated_size)
    |> then(&("[truncated]…\n" <> &1))
  end

  defp cap_content(content), do: content

  defp parse_metadata(nil), do: %{}

  defp parse_metadata(json) when is_binary(json) do
    case Jason.decode(json) do
      {:ok, map} when is_map(map) -> map
      _ -> %{}
    end
  end

  defp parse_metadata(map) when is_map(map), do: map
  defp parse_metadata(_), do: %{}

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
