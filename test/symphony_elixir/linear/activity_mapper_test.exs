defmodule SymphonyElixir.Linear.ActivityMapperTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Linear.ActivityMapper

  describe "session_started" do
    test "maps to thought activity" do
      event = %{event: :session_started, session_id: "sess-1"}
      result = ActivityMapper.map_event(event)

      assert result == %{type: :thought, body: "Starting session..."}
    end
  end

  describe "claude/thinking" do
    test "maps to ephemeral thought" do
      event = %{
        event: :notification,
        payload: %{
          "method" => "claude/thinking",
          "params" => %{"content" => "Let me analyze this..."}
        }
      }

      result = ActivityMapper.map_event(event)

      assert result == %{type: :thought, body: "Let me analyze this...", ephemeral: true}
    end

    test "handles missing content" do
      event = %{
        event: :notification,
        payload: %{"method" => "claude/thinking", "params" => %{}}
      }

      result = ActivityMapper.map_event(event)
      assert result == %{type: :thought, body: "", ephemeral: true}
    end
  end

  describe "claude/tool_use" do
    test "maps to action activity" do
      event = %{
        event: :notification,
        payload: %{
          "method" => "claude/tool_use",
          "params" => %{
            "name" => "edit_file",
            "input" => %{"path" => "lib/foo.ex", "content" => "defmodule Foo do end"}
          }
        }
      }

      result = ActivityMapper.map_event(event)

      assert result.type == :action
      assert result.action == "edit_file"
      assert result.parameter =~ "path:"
      assert result.parameter =~ "content:"
    end

    test "handles missing tool name" do
      event = %{
        event: :notification,
        payload: %{
          "method" => "claude/tool_use",
          "params" => %{}
        }
      }

      result = ActivityMapper.map_event(event)
      assert result.action == "unknown"
    end
  end

  describe "tool_call_completed" do
    test "maps to action with result" do
      event = %{
        event: :tool_call_completed,
        payload: %{
          "params" => %{"name" => "read_file"},
          "result" => %{"output" => "file contents here"}
        }
      }

      result = ActivityMapper.map_event(event)

      assert result.type == :action
      assert result.action == "read_file"
      assert result.result == "file contents here"
    end

    test "handles missing tool name and result" do
      event = %{event: :tool_call_completed, payload: %{}}

      result = ActivityMapper.map_event(event)

      assert result.type == :action
      assert result.action == "unknown"
      assert result.result == ""
    end
  end

  describe "tool_call_failed" do
    test "maps to error activity" do
      event = %{
        event: :tool_call_failed,
        payload: %{
          "result" => %{"error" => "Permission denied"}
        }
      }

      result = ActivityMapper.map_event(event)

      assert result == %{type: :error, body: "Permission denied"}
    end

    test "falls back to unknown error" do
      event = %{event: :tool_call_failed, payload: %{}}

      result = ActivityMapper.map_event(event)
      assert result == %{type: :error, body: "unknown error"}
    end
  end

  describe "turn_completed" do
    test "maps to response activity" do
      event = %{event: :turn_completed, details: %{summary: "I've updated the file."}}

      result = ActivityMapper.map_event(event)

      assert result == %{type: :response, body: "I've updated the file."}
    end

    test "uses default body when no summary" do
      event = %{event: :turn_completed}

      result = ActivityMapper.map_event(event)
      assert result == %{type: :response, body: "Turn completed"}
    end

    test "extracts summary from payload params" do
      event = %{
        event: :turn_completed,
        payload: %{"params" => %{"summary" => "Done with changes."}}
      }

      result = ActivityMapper.map_event(event)
      assert result == %{type: :response, body: "Done with changes."}
    end
  end

  describe "turn_failed" do
    test "maps to error activity" do
      event = %{event: :turn_failed, details: %{reason: "Rate limited"}}

      result = ActivityMapper.map_event(event)

      assert result == %{type: :error, body: "Rate limited"}
    end

    test "extracts error from payload" do
      event = %{
        event: :turn_failed,
        payload: %{"params" => %{"error" => "Timeout reached"}}
      }

      result = ActivityMapper.map_event(event)
      assert result == %{type: :error, body: "Timeout reached"}
    end

    test "falls back to unknown error" do
      event = %{event: :turn_failed}

      result = ActivityMapper.map_event(event)
      assert result == %{type: :error, body: "unknown error"}
    end
  end

  describe "unhandled events" do
    test "returns nil for unknown event types" do
      assert ActivityMapper.map_event(%{event: :something_else}) == nil
    end

    test "returns nil for unknown notification methods" do
      event = %{
        event: :notification,
        payload: %{"method" => "some/other_method", "params" => %{}}
      }

      assert ActivityMapper.map_event(event) == nil
    end

    test "returns nil for empty map" do
      assert ActivityMapper.map_event(%{}) == nil
    end
  end
end
