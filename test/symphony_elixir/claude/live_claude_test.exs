defmodule SymphonyElixir.Claude.LiveClaudeTest do
  @moduledoc """
  Integration test that actually spawns `claude -p` and verifies the full
  event pipeline: port launch → NDJSON parsing → event translation → result.

  Gated behind SYMPHONY_RUN_CLAUDE_E2E=1 so it doesn't run in normal CI.
  Requires `claude` CLI to be installed and authenticated.
  """

  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Claude.AppServer

  @moduletag :live_claude_e2e
  @moduletag timeout: 120_000

  @skip_reason if(System.get_env("SYMPHONY_RUN_CLAUDE_E2E") != "1",
                 do: "set SYMPHONY_RUN_CLAUDE_E2E=1 to run the live Claude integration test"
               )

  describe "Claude.AppServer live integration" do
    @tag skip: @skip_reason
    test "start_session, run_turn with simple prompt, stop_session" do
      workspace = create_test_workspace()

      write_workflow_file!(Workflow.workflow_file_path(),
        engine: "claude",
        workspace_root: Path.dirname(workspace)
      )

      events = :ets.new(:claude_test_events, [:bag, :public])

      on_message = fn event ->
        :ets.insert(events, {event.event, event})
      end

      issue = %{
        id: "test-issue-id",
        identifier: "TEST-1",
        title: "Test issue",
        state: "In Progress"
      }

      # Start session
      assert {:ok, session} = AppServer.start_session(workspace)
      assert session.workspace == workspace

      # Run a simple turn
      prompt = "Reply with exactly: SYMPHONY_TEST_OK. Do not use any tools. Just output that text."

      result = AppServer.run_turn(session, prompt, issue, on_message: on_message)

      assert {:ok, turn_result} = result
      assert turn_result.result == :turn_completed
      assert is_binary(turn_result.session_id)
      assert is_binary(turn_result.turn_id)

      # Verify usage was tracked
      assert is_map(turn_result.usage)
      assert turn_result.usage.input_tokens > 0
      assert turn_result.usage.output_tokens > 0
      assert turn_result.usage.total_tokens > 0

      # Verify cost was tracked
      assert is_number(turn_result.total_cost_usd)
      assert turn_result.total_cost_usd > 0

      # Verify events were emitted
      all_events = :ets.tab2list(events)
      event_types = Enum.map(all_events, fn {type, _event} -> type end) |> Enum.uniq()

      # Must have session_started (from system init message)
      assert :session_started in event_types

      # Must have at least one notification (assistant text response)
      assert :notification in event_types

      # Must have turn_completed (from result message)
      assert :turn_completed in event_types

      # Verify the assistant response contains our test string
      notification_events =
        all_events
        |> Enum.filter(fn {type, _} -> type == :notification end)
        |> Enum.map(fn {_, event} -> event end)

      text_events =
        Enum.filter(notification_events, fn event ->
          get_in(event, [:message, "method"]) == "claude/assistant_message"
        end)

      assert text_events != [], "Expected at least one assistant text message"

      response_text =
        Enum.map_join(text_events, fn event ->
          get_in(event, [:message, "params", "content"]) || ""
        end)

      assert response_text =~ "SYMPHONY_TEST_OK",
             "Expected response to contain SYMPHONY_TEST_OK, got: #{String.slice(response_text, 0, 200)}"

      # Stop session (no-op for Claude, but verify it works)
      assert :ok = AppServer.stop_session(session)

      :ets.delete(events)
    end

    @tag skip: @skip_reason
    test "run_turn emits tool_call events when Claude uses tools" do
      workspace = create_test_workspace()
      File.write!(Path.join(workspace, "test_file.txt"), "Hello from Symphony test\n")

      write_workflow_file!(Workflow.workflow_file_path(),
        engine: "claude",
        workspace_root: Path.dirname(workspace)
      )

      events = :ets.new(:claude_tool_events, [:bag, :public])

      on_message = fn event ->
        :ets.insert(events, {event.event, event})
      end

      issue = %{id: "test-issue-id-2", identifier: "TEST-2", title: "Read test", state: "In Progress"}

      assert {:ok, session} = AppServer.start_session(workspace)

      prompt = "Read the file test_file.txt in the current directory and tell me its contents. Be brief."

      assert {:ok, turn_result} = AppServer.run_turn(session, prompt, issue, on_message: on_message)
      assert turn_result.result == :turn_completed

      all_events = :ets.tab2list(events)
      event_types = Enum.map(all_events, fn {type, _} -> type end) |> Enum.uniq()

      # Claude should have used a tool (Read) to read the file
      tool_notifications =
        all_events
        |> Enum.filter(fn {type, _} -> type == :notification end)
        |> Enum.map(fn {_, event} -> event end)
        |> Enum.filter(fn event ->
          get_in(event, [:message, "method"]) == "claude/tool_use"
        end)

      assert tool_notifications != [], "Expected Claude to use at least one tool, events: #{inspect(event_types)}"

      # Should also have tool_call_completed events (from user message with tool_result)
      assert :tool_call_completed in event_types

      :ok = AppServer.stop_session(session)
      :ets.delete(events)
    end
  end

  defp create_test_workspace do
    workspace =
      Path.join(
        System.tmp_dir!(),
        "symphony-claude-live-test-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(workspace)

    on_exit(fn -> File.rm_rf(workspace) end)

    workspace
  end
end
