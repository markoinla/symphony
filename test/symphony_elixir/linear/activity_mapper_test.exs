defmodule SymphonyElixir.Linear.ActivityMapperTest do
  use SymphonyElixir.DataCase, async: true

  alias SymphonyElixir.Linear.ActivityMapper

  describe "map_event/1 - session lifecycle" do
    test "maps session_started to ephemeral thought" do
      event = %{event: :session_started, timestamp: DateTime.utc_now()}
      result = ActivityMapper.map_event(event)

      assert result.type == "thought"
      assert result.ephemeral == true
      assert result.body =~ "Starting session"
    end
  end

  describe "map_event/1 - claude thinking" do
    test "maps claude/thinking to ephemeral thought" do
      event = %{
        event: :notification,
        timestamp: DateTime.utc_now(),
        message: %{"method" => "claude/thinking", "params" => %{"content" => "Let me analyze..."}},
        payload: %{"method" => "claude/thinking", "params" => %{"content" => "Let me analyze..."}}
      }

      result = ActivityMapper.map_event(event)

      assert result.type == "thought"
      assert result.ephemeral == true
      assert result.body == "Let me analyze..."
    end

    test "returns nil for empty thinking" do
      event = %{
        event: :notification,
        timestamp: DateTime.utc_now(),
        message: %{"method" => "claude/thinking", "params" => %{"content" => ""}},
        payload: %{"method" => "claude/thinking", "params" => %{"content" => ""}}
      }

      assert ActivityMapper.map_event(event) == nil
    end
  end

  describe "map_event/1 - claude tool_use" do
    test "maps claude/tool_use to action" do
      event = %{
        event: :notification,
        timestamp: DateTime.utc_now(),
        message: %{
          "method" => "claude/tool_use",
          "params" => %{
            "name" => "Read",
            "input" => %{"file_path" => "/home/user/test.ex"},
            "tool_use_id" => "tool-1"
          }
        },
        payload: %{
          "method" => "claude/tool_use",
          "params" => %{
            "name" => "Read",
            "input" => %{"file_path" => "/home/user/test.ex"},
            "tool_use_id" => "tool-1"
          }
        }
      }

      result = ActivityMapper.map_event(event)

      assert result.type == "action"
      assert result.action == "Read"
      assert result.parameter =~ "file_path"
    end
  end

  describe "map_event/1 - assistant message" do
    test "maps claude/assistant_message to response" do
      event = %{
        event: :notification,
        timestamp: DateTime.utc_now(),
        message: %{
          "method" => "claude/assistant_message",
          "params" => %{"content" => "Here is the fix..."}
        },
        payload: %{
          "method" => "claude/assistant_message",
          "params" => %{"content" => "Here is the fix..."}
        }
      }

      result = ActivityMapper.map_event(event)

      assert result.type == "response"
      assert result.body == "Here is the fix..."
    end
  end

  describe "map_event/1 - tool results" do
    test "maps tool_call_completed to action with result" do
      event = %{
        event: :tool_call_completed,
        timestamp: DateTime.utc_now(),
        tool_use_id: "tool-1",
        message: %{"method" => "claude/tool_result", "params" => %{"content" => "File contents here"}},
        payload: %{}
      }

      result = ActivityMapper.map_event(event)

      assert result.type == "action"
      assert result.action == "tool_result"
      assert result.parameter == "tool-1"
      assert result.result == "File contents here"
    end

    test "maps tool_call_failed to error" do
      event = %{
        event: :tool_call_failed,
        timestamp: DateTime.utc_now(),
        tool_use_id: "tool-1",
        message: %{"method" => "claude/tool_result", "params" => %{"content" => "Permission denied"}},
        payload: %{}
      }

      result = ActivityMapper.map_event(event)

      assert result.type == "error"
      assert result.body == "Permission denied"
    end
  end

  describe "map_event/1 - turn completion" do
    test "maps turn_completed to response" do
      event = %{
        event: :turn_completed,
        timestamp: DateTime.utc_now(),
        total_cost_usd: 0.0512,
        num_turns: 3,
        session_id: "sess-1"
      }

      result = ActivityMapper.map_event(event)

      assert result.type == "response"
      assert result.body =~ "Turn completed"
      assert result.body =~ "0.0512"
      assert result.body =~ "3"
    end

    test "maps turn_failed to error" do
      event = %{
        event: :turn_failed,
        timestamp: DateTime.utc_now(),
        errors: [%{"message" => "Rate limited"}],
        subtype: "api_error"
      }

      result = ActivityMapper.map_event(event)

      assert result.type == "error"
      assert result.body == "Rate limited"
    end

    test "handles turn_failed with no errors" do
      event = %{
        event: :turn_failed,
        timestamp: DateTime.utc_now(),
        errors: [],
        subtype: "timeout"
      }

      result = ActivityMapper.map_event(event)

      assert result.type == "error"
      assert result.body =~ "timeout"
    end
  end

  describe "map_event/1 - noise filtering" do
    test "returns nil for usage notifications" do
      event = %{
        event: :notification,
        timestamp: DateTime.utc_now(),
        message: %{"method" => "claude/usage", "params" => %{}},
        payload: %{"method" => "claude/usage", "params" => %{}}
      }

      assert ActivityMapper.map_event(event) == nil
    end

    test "returns nil for rate limit notifications" do
      event = %{
        event: :notification,
        timestamp: DateTime.utc_now(),
        message: %{"method" => "claude/rate_limit", "params" => %{}},
        payload: %{"method" => "claude/rate_limit", "params" => %{}}
      }

      assert ActivityMapper.map_event(event) == nil
    end

    test "returns nil for unknown events" do
      assert ActivityMapper.map_event(%{event: :unknown_event}) == nil
    end
  end

  describe "truncation" do
    test "truncates long tool results" do
      long_content = String.duplicate("x", 600)

      event = %{
        event: :tool_call_completed,
        timestamp: DateTime.utc_now(),
        tool_use_id: "tool-1",
        message: %{"method" => "claude/tool_result", "params" => %{"content" => long_content}},
        payload: %{}
      }

      result = ActivityMapper.map_event(event)
      assert String.length(result.result) < 600
      assert String.ends_with?(result.result, "...")
    end
  end
end
