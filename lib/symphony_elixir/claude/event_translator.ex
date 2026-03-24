defmodule SymphonyElixir.Claude.EventTranslator do
  @moduledoc """
  Translates Claude Code CLI NDJSON messages into normalized engine events.

  Each translated event has the shape `%{event: atom, timestamp: DateTime, ...}`
  matching what SessionLog and Orchestrator expect.
  """

  @spec translate(map()) :: [map()]
  def translate(%{"type" => "system", "subtype" => "init"} = msg) do
    [
      %{
        event: :session_started,
        timestamp: DateTime.utc_now(),
        session_id: Map.get(msg, "session_id"),
        model: Map.get(msg, "model"),
        payload: msg,
        message: %{
          "method" => "claude/init",
          "params" => %{"session_id" => Map.get(msg, "session_id"), "model" => Map.get(msg, "model")}
        }
      }
    ]
  end

  def translate(%{"type" => "assistant", "message" => message} = msg) do
    content_blocks = Map.get(message, "content", [])
    usage = Map.get(message, "usage")
    session_id = Map.get(msg, "session_id")

    block_events =
      Enum.flat_map(content_blocks, fn block ->
        translate_content_block(block, session_id)
      end)

    usage_event =
      if usage do
        [
          %{
            event: :notification,
            timestamp: DateTime.utc_now(),
            usage: normalize_usage(usage),
            payload: %{"method" => "claude/usage", "params" => usage},
            message: %{"method" => "claude/usage", "params" => usage}
          }
        ]
      else
        []
      end

    block_events ++ usage_event
  end

  def translate(%{"type" => "user", "message" => message} = msg) do
    content = Map.get(message, "content", [])

    Enum.flat_map(content, fn
      %{"type" => "tool_result", "tool_use_id" => tool_id} = block ->
        content_text = extract_tool_result_text(block)
        is_error = Map.get(block, "is_error", false)

        [
          %{
            event: if(is_error, do: :tool_call_failed, else: :tool_call_completed),
            timestamp: DateTime.utc_now(),
            tool_use_id: tool_id,
            payload: msg,
            message: %{
              "method" => "claude/tool_result",
              "params" => %{
                "tool_use_id" => tool_id,
                "content" => content_text,
                "is_error" => is_error
              }
            }
          }
        ]

      _ ->
        []
    end)
  end

  def translate(%{"type" => "result", "subtype" => subtype} = msg) do
    is_error = Map.get(msg, "is_error", false)
    usage = Map.get(msg, "usage")

    event =
      if is_error do
        :turn_failed
      else
        :turn_completed
      end

    [
      %{
        event: event,
        timestamp: DateTime.utc_now(),
        session_id: Map.get(msg, "session_id"),
        subtype: subtype,
        result: Map.get(msg, "result"),
        total_cost_usd: Map.get(msg, "total_cost_usd"),
        duration_ms: Map.get(msg, "duration_ms"),
        num_turns: Map.get(msg, "num_turns"),
        usage: if(usage, do: normalize_usage(usage), else: %{}),
        errors: Map.get(msg, "errors"),
        payload: msg,
        message: %{
          "method" => if(is_error, do: "turn/failed", else: "turn/completed"),
          "params" => %{
            "subtype" => subtype,
            "total_cost_usd" => Map.get(msg, "total_cost_usd"),
            "duration_ms" => Map.get(msg, "duration_ms"),
            "num_turns" => Map.get(msg, "num_turns")
          }
        }
      }
    ]
  end

  def translate(%{"type" => "rate_limit_event"} = msg) do
    [
      %{
        event: :notification,
        timestamp: DateTime.utc_now(),
        rate_limits: Map.get(msg, "rate_limit_info"),
        payload: msg,
        message: %{
          "method" => "claude/rate_limit",
          "params" => Map.get(msg, "rate_limit_info", %{})
        }
      }
    ]
  end

  def translate(%{"type" => "system", "subtype" => "api_retry"} = msg) do
    [
      %{
        event: :notification,
        timestamp: DateTime.utc_now(),
        payload: msg,
        message: %{
          "method" => "claude/api_retry",
          "params" => %{
            "attempt" => Map.get(msg, "attempt"),
            "error" => Map.get(msg, "error")
          }
        }
      }
    ]
  end

  # Ignore other message types (stream_event, tool_progress, etc.)
  def translate(_msg), do: []

  # -- Content block translation --

  defp translate_content_block(%{"type" => "text", "text" => text}, _session_id) do
    [
      %{
        event: :notification,
        timestamp: DateTime.utc_now(),
        payload: %{"method" => "claude/assistant_message", "params" => %{"content" => text}},
        message: %{"method" => "claude/assistant_message", "params" => %{"content" => text}}
      }
    ]
  end

  defp translate_content_block(%{"type" => "thinking", "thinking" => text}, _session_id) do
    [
      %{
        event: :notification,
        timestamp: DateTime.utc_now(),
        payload: %{"method" => "claude/thinking", "params" => %{"content" => text}},
        message: %{"method" => "claude/thinking", "params" => %{"content" => text}}
      }
    ]
  end

  defp translate_content_block(%{"type" => "tool_use"} = block, _session_id) do
    [
      %{
        event: :notification,
        timestamp: DateTime.utc_now(),
        payload: %{
          "method" => "claude/tool_use",
          "params" => %{
            "tool_use_id" => Map.get(block, "id"),
            "name" => Map.get(block, "name"),
            "input" => Map.get(block, "input")
          }
        },
        message: %{
          "method" => "claude/tool_use",
          "params" => %{
            "tool_use_id" => Map.get(block, "id"),
            "name" => Map.get(block, "name"),
            "input" => Map.get(block, "input")
          }
        }
      }
    ]
  end

  defp translate_content_block(_block, _session_id), do: []

  # -- Helpers --

  @spec normalize_usage(map()) ::
          %{input_tokens: non_neg_integer(), output_tokens: non_neg_integer(), total_tokens: non_neg_integer()}
  def normalize_usage(usage) when is_map(usage) do
    input = Map.get(usage, "input_tokens", 0)
    cache_read = Map.get(usage, "cache_read_input_tokens", 0)
    cache_creation = Map.get(usage, "cache_creation_input_tokens", 0)
    output = Map.get(usage, "output_tokens", 0)
    total_input = input + cache_read + cache_creation

    %{
      input_tokens: total_input,
      output_tokens: output,
      total_tokens: total_input + output
    }
  end

  def normalize_usage(_), do: %{input_tokens: 0, output_tokens: 0, total_tokens: 0}

  defp extract_tool_result_text(%{"content" => content}) when is_binary(content), do: content

  defp extract_tool_result_text(%{"content" => content}) when is_list(content) do
    Enum.map_join(content, "\n", fn
      %{"type" => "text", "text" => text} -> text
      _ -> ""
    end)
  end

  defp extract_tool_result_text(_), do: ""
end
