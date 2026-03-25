defmodule SymphonyElixir.Linear.ActivityMapper do
  @moduledoc """
  Maps normalized engine events to Linear Agent Activity content.

  Returns a content map suitable for `AgentAPI.create_activity/2`,
  or `nil` when the event should not produce an activity.
  """

  @spec map_event(map()) :: map() | nil

  # :session_started is handled directly by WebhookDispatcher.emit_initial_thought/2
  def map_event(%{event: :session_started}), do: nil

  def map_event(%{event: :notification} = msg) do
    method = get_method(msg)
    map_notification(method, msg)
  end

  def map_event(%{event: :tool_call_completed} = msg) do
    tool_id = Map.get(msg, :tool_use_id, "unknown")
    content = get_in(msg, [:message, "params", "content"]) || ""
    truncated = truncate(content, 500)

    %{type: "action", action: "tool_result", parameter: tool_id, result: truncated}
  end

  def map_event(%{event: :tool_call_failed} = msg) do
    error = get_in(msg, [:message, "params", "content"]) || "Tool call failed"
    %{type: "error", body: truncate(error, 500)}
  end

  def map_event(%{event: :turn_completed} = msg) do
    cost = Map.get(msg, :total_cost_usd)
    turns = Map.get(msg, :num_turns)

    body =
      ["Turn completed"]
      |> maybe_append(cost, &"Cost: $#{Float.round(&1, 4)}")
      |> maybe_append(turns, &"Turns: #{&1}")
      |> Enum.join(" | ")

    %{type: "thought", body: body}
  end

  def map_event(%{event: :turn_failed} = msg) do
    errors = Map.get(msg, :errors, [])
    subtype = Map.get(msg, :subtype)

    body =
      case errors do
        [first | _] when is_map(first) -> Map.get(first, "message", "Turn failed")
        [first | _] when is_binary(first) -> first
        _ -> "Turn failed" <> if(subtype, do: ": #{subtype}", else: "")
      end

    %{type: "error", body: truncate(body, 500)}
  end

  def map_event(_msg), do: nil

  # -- Notification submethods --

  defp map_notification("claude/thinking", msg) do
    content = get_in(msg, [:message, "params", "content"]) || ""

    if content != "" do
      %{type: "thought", body: truncate(content, 1000), ephemeral: true}
    end
  end

  defp map_notification("claude/tool_use", msg) do
    name = get_in(msg, [:message, "params", "name"]) || "unknown"
    input = get_in(msg, [:message, "params", "input"]) || %{}
    parameter = summarize_input(input)

    %{type: "action", action: name, parameter: parameter}
  end

  defp map_notification("claude/assistant_message", msg) do
    content = get_in(msg, [:message, "params", "content"]) || ""

    if content != "" do
      %{type: "response", body: truncate(content, 2000)}
    end
  end

  # Codex agent message
  defp map_notification("codex/event/agent_message_delta", _msg), do: nil
  defp map_notification("codex/event/agent_message_content_delta", _msg), do: nil
  defp map_notification("item/agentMessage/delta", _msg), do: nil

  # Codex reasoning
  defp map_notification("codex/event/agent_reasoning", msg) do
    content = extract_codex_reasoning(msg)

    if content && content != "" do
      %{type: "thought", body: truncate(content, 1000), ephemeral: true}
    end
  end

  defp map_notification("codex/event/agent_reasoning_delta", _msg), do: nil
  defp map_notification("codex/event/reasoning_content_delta", _msg), do: nil

  # Codex tool events
  defp map_notification("codex/event/exec_command_end", msg) do
    exit_code = get_in(msg, [:payload, "params", "exit_code"])
    cmd = get_in(msg, [:payload, "params", "command"])
    status = if exit_code == 0, do: "completed", else: "failed (exit #{exit_code})"
    %{type: "action", action: "exec_command", parameter: truncate(cmd || "", 200), result: status}
  end

  defp map_notification("codex/event/mcp_tool_call_end", msg) do
    name = get_in(msg, [:payload, "params", "tool_name"]) || "mcp_tool"
    %{type: "action", action: name, parameter: "completed"}
  end

  # Skip noise
  defp map_notification("claude/usage", _msg), do: nil
  defp map_notification("claude/rate_limit", _msg), do: nil
  defp map_notification("claude/api_retry", _msg), do: nil
  defp map_notification(_method, _msg), do: nil

  # -- Helpers --

  defp get_method(msg) do
    get_in(msg, [:message, "method"]) || get_in(msg, [:payload, "method"])
  end

  defp summarize_input(input) when is_map(input) do
    input
    |> inspect(limit: 200, printable_limit: 200)
    |> truncate(300)
  end

  defp summarize_input(input) when is_binary(input), do: truncate(input, 300)
  defp summarize_input(_input), do: ""

  defp extract_codex_reasoning(msg) do
    get_in(msg, [:payload, "params", "reasoning"]) ||
      get_in(msg, [:payload, "params", "summary_text"]) ||
      get_in(msg, [:payload, "params", "content"])
  end

  defp truncate(text, max) when is_binary(text) and byte_size(text) > max do
    String.slice(text, 0, max) <> "..."
  end

  defp truncate(text, _max) when is_binary(text), do: text
  defp truncate(_text, _max), do: ""

  defp maybe_append(parts, nil, _formatter), do: parts
  defp maybe_append(parts, value, formatter), do: parts ++ [formatter.(value)]
end
