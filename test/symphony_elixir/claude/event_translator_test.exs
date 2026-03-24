defmodule SymphonyElixir.Claude.EventTranslatorTest do
  use SymphonyElixir.DataCase, async: true

  alias SymphonyElixir.Claude.EventTranslator

  describe "system init" do
    test "translates to session_started event" do
      msg = %{
        "type" => "system",
        "subtype" => "init",
        "session_id" => "sess-1",
        "model" => "claude-opus-4-6"
      }

      assert [event] = EventTranslator.translate(msg)
      assert event.event == :session_started
      assert event.session_id == "sess-1"
      assert event.model == "claude-opus-4-6"
    end
  end

  describe "assistant message" do
    test "translates text block to notification" do
      msg = %{
        "type" => "assistant",
        "message" => %{
          "content" => [%{"type" => "text", "text" => "Hello world"}]
        },
        "session_id" => "sess-1"
      }

      events = EventTranslator.translate(msg)
      text_event = Enum.find(events, &(&1.message["method"] == "claude/assistant_message"))
      assert text_event.event == :notification
      assert text_event.message["params"]["content"] == "Hello world"
    end

    test "translates thinking block to notification" do
      msg = %{
        "type" => "assistant",
        "message" => %{
          "content" => [%{"type" => "thinking", "thinking" => "Let me think..."}]
        },
        "session_id" => "sess-1"
      }

      events = EventTranslator.translate(msg)
      thinking_event = Enum.find(events, &(&1.message["method"] == "claude/thinking"))
      assert thinking_event.event == :notification
      assert thinking_event.message["params"]["content"] == "Let me think..."
    end

    test "translates tool_use block to notification" do
      msg = %{
        "type" => "assistant",
        "message" => %{
          "content" => [
            %{
              "type" => "tool_use",
              "id" => "toolu_1",
              "name" => "Read",
              "input" => %{"file_path" => "/etc/hostname"}
            }
          ]
        },
        "session_id" => "sess-1"
      }

      events = EventTranslator.translate(msg)
      tool_event = Enum.find(events, &(&1.message["method"] == "claude/tool_use"))
      assert tool_event.event == :notification
      assert tool_event.message["params"]["name"] == "Read"
      assert tool_event.message["params"]["tool_use_id"] == "toolu_1"
    end

    test "emits usage event when usage present" do
      msg = %{
        "type" => "assistant",
        "message" => %{
          "content" => [%{"type" => "text", "text" => "Hi"}],
          "usage" => %{"input_tokens" => 100, "output_tokens" => 50}
        },
        "session_id" => "sess-1"
      }

      events = EventTranslator.translate(msg)
      usage_event = Enum.find(events, &(&1.message["method"] == "claude/usage"))
      assert usage_event.usage.input_tokens == 100
      assert usage_event.usage.output_tokens == 50
      assert usage_event.usage.total_tokens == 150
    end

    test "handles multiple content blocks" do
      msg = %{
        "type" => "assistant",
        "message" => %{
          "content" => [
            %{"type" => "thinking", "thinking" => "hmm"},
            %{"type" => "text", "text" => "result"},
            %{"type" => "tool_use", "id" => "t1", "name" => "Bash", "input" => %{}}
          ]
        },
        "session_id" => "sess-1"
      }

      events = EventTranslator.translate(msg)
      methods = Enum.map(events, & &1.message["method"])
      assert "claude/thinking" in methods
      assert "claude/assistant_message" in methods
      assert "claude/tool_use" in methods
    end
  end

  describe "user message (tool results)" do
    test "translates successful tool_result to tool_call_completed" do
      msg = %{
        "type" => "user",
        "message" => %{
          "role" => "user",
          "content" => [
            %{
              "type" => "tool_result",
              "tool_use_id" => "toolu_1",
              "content" => "file contents here"
            }
          ]
        },
        "session_id" => "sess-1"
      }

      assert [event] = EventTranslator.translate(msg)
      assert event.event == :tool_call_completed
      assert event.tool_use_id == "toolu_1"
    end

    test "translates error tool_result to tool_call_failed" do
      msg = %{
        "type" => "user",
        "message" => %{
          "role" => "user",
          "content" => [
            %{
              "type" => "tool_result",
              "tool_use_id" => "toolu_1",
              "content" => "Permission denied",
              "is_error" => true
            }
          ]
        },
        "session_id" => "sess-1"
      }

      assert [event] = EventTranslator.translate(msg)
      assert event.event == :tool_call_failed
    end
  end

  describe "result message" do
    test "translates success result to turn_completed" do
      msg = %{
        "type" => "result",
        "subtype" => "success",
        "is_error" => false,
        "session_id" => "sess-1",
        "total_cost_usd" => 0.05,
        "duration_ms" => 5000,
        "num_turns" => 3,
        "result" => "Task completed successfully.",
        "usage" => %{"input_tokens" => 1000, "output_tokens" => 500}
      }

      assert [event] = EventTranslator.translate(msg)
      assert event.event == :turn_completed
      assert event.total_cost_usd == 0.05
      assert event.duration_ms == 5000
      assert event.num_turns == 3
      assert event.usage.input_tokens == 1000
      assert event.usage.output_tokens == 500
      assert event.usage.total_tokens == 1500
    end

    test "translates error result to turn_failed" do
      msg = %{
        "type" => "result",
        "subtype" => "error_during_execution",
        "is_error" => true,
        "session_id" => "sess-1",
        "errors" => ["Something went wrong"],
        "usage" => %{"input_tokens" => 100, "output_tokens" => 10}
      }

      assert [event] = EventTranslator.translate(msg)
      assert event.event == :turn_failed
      assert event.errors == ["Something went wrong"]
    end
  end

  describe "rate_limit_event" do
    test "translates to notification" do
      msg = %{
        "type" => "rate_limit_event",
        "rate_limit_info" => %{"status" => "allowed"},
        "session_id" => "sess-1"
      }

      assert [event] = EventTranslator.translate(msg)
      assert event.event == :notification
      assert event.rate_limits == %{"status" => "allowed"}
    end
  end

  describe "unknown messages" do
    test "returns empty list for unknown types" do
      assert [] = EventTranslator.translate(%{"type" => "stream_event"})
      assert [] = EventTranslator.translate(%{"type" => "tool_progress"})
      assert [] = EventTranslator.translate(%{})
    end
  end
end
