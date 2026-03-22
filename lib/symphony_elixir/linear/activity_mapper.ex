defmodule SymphonyElixir.Linear.ActivityMapper do
  @moduledoc """
  Maps engine events to Linear Agent Activity content maps.

  Only emits on completed blocks/boundaries, not per-delta, aligning with
  SessionLog's stream-aggregation approach.
  """

  @type activity :: SymphonyElixir.Linear.AgentAPI.activity_content()

  @doc """
  Maps an engine event to an activity content map, or `nil` if the event
  should not produce an activity.
  """
  @spec map_event(map()) :: activity() | nil

  # Session started
  def map_event(%{event: :session_started}) do
    %{type: :thought, body: "Starting session..."}
  end

  # Turn completed — response with final summary
  def map_event(%{event: :turn_completed} = msg) do
    body = extract_turn_summary(msg)
    %{type: :response, body: body}
  end

  # Turn failed — error
  def map_event(%{event: :turn_failed} = msg) do
    reason = extract_failure_reason(msg)
    %{type: :error, body: reason}
  end

  # Tool call completed — action with result
  def map_event(%{event: :tool_call_completed} = msg) do
    payload = Map.get(msg, :payload, %{})
    tool_name = extract_tool_name(payload)
    result = extract_tool_result(payload)

    %{type: :action, action: tool_name || "unknown", parameter: "", result: result}
  end

  # Tool call failed — error
  def map_event(%{event: :tool_call_failed} = msg) do
    payload = Map.get(msg, :payload, %{})
    error = extract_error(payload)
    %{type: :error, body: error}
  end

  # Notification events — claude/thinking and claude/tool_use
  def map_event(%{event: :notification} = msg) do
    payload = Map.get(msg, :payload, %{})
    method = get_method(payload)
    map_notification(method, payload)
  end

  # Catch-all — no activity
  def map_event(_msg), do: nil

  # ── Notification mapping ────────────────────────────────────────────

  defp map_notification("claude/thinking", payload) do
    content = payload_path(payload, ["params", "content"]) || ""
    %{type: :thought, body: content, ephemeral: true}
  end

  defp map_notification("claude/tool_use", payload) do
    tool_name = payload_path(payload, ["params", "name"]) || "unknown"
    input = payload_path(payload, ["params", "input"]) || %{}
    parameter = summarize_input(input)
    %{type: :action, action: tool_name, parameter: parameter}
  end

  defp map_notification(_method, _payload), do: nil

  # ── Extraction helpers ──────────────────────────────────────────────

  defp get_method(%{"method" => method}) when is_binary(method), do: method
  defp get_method(_payload), do: nil

  defp payload_path(payload, keys) when is_map(payload) do
    Enum.reduce_while(keys, payload, fn key, acc ->
      case acc do
        map when is_map(map) -> {:cont, Map.get(map, key)}
        _ -> {:halt, nil}
      end
    end)
  end

  defp payload_path(_payload, _keys), do: nil

  defp extract_tool_name(payload) when is_map(payload) do
    params = Map.get(payload, "params", %{})
    result = Map.get(payload, "result", %{}) || %{}

    Map.get(params, "tool") ||
      Map.get(params, "name") ||
      Map.get(result, "tool") ||
      Map.get(result, "name")
  end

  defp extract_tool_name(_payload), do: nil

  defp extract_tool_result(payload) when is_map(payload) do
    result = Map.get(payload, "result", %{}) || %{}

    case Map.get(result, "output") || Map.get(result, "content") do
      text when is_binary(text) -> truncate(text, 500)
      _ -> ""
    end
  end

  defp extract_tool_result(_payload), do: ""

  defp extract_error(payload) when is_map(payload) do
    result = Map.get(payload, "result", %{}) || %{}
    Map.get(result, "error") || Map.get(result, "message") || "unknown error"
  end

  defp extract_error(_payload), do: "unknown error"

  defp extract_turn_summary(%{details: %{summary: summary}}) when is_binary(summary), do: summary

  defp extract_turn_summary(%{payload: %{"params" => %{"summary" => summary}}})
       when is_binary(summary),
       do: summary

  defp extract_turn_summary(_msg), do: "Turn completed"

  defp extract_failure_reason(%{details: %{reason: reason}}) when is_binary(reason), do: reason

  defp extract_failure_reason(%{payload: %{"params" => %{"error" => error}}})
       when is_binary(error),
       do: error

  defp extract_failure_reason(_msg), do: "unknown error"

  defp summarize_input(input) when is_map(input) do
    input
    |> Enum.map_join(", ", fn {k, v} -> "#{k}: #{truncate(inspect(v), 100)}" end)
    |> truncate(300)
  end

  defp summarize_input(input) when is_binary(input), do: truncate(input, 300)
  defp summarize_input(_input), do: ""

  defp truncate(text, max) when byte_size(text) > max do
    String.slice(text, 0, max) <> "..."
  end

  defp truncate(text, _max), do: text
end
