defmodule SymphonyElixir.SessionLogTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.SessionLog
  alias SymphonyElixirWeb.ObservabilityPubSub

  test "keeps distinct streamed agent items separated by item identity" do
    issue_id = unique_id("issue")
    session_id = unique_id("session")

    assert :ok = ObservabilityPubSub.subscribe_session(issue_id)
    start_session_log!(issue_id, session_id)

    now = DateTime.utc_now() |> DateTime.truncate(:second)

    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "item/agentMessage/delta",
        "params" => %{"itemId" => "msg-1", "delta" => "First step."}
      }
    })

    assert_receive {:session_message, %{id: 1, type: :response, content: "First step."}}

    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "item/agentMessage/delta",
        "params" => %{"itemId" => "msg-2", "delta" => "Second step."}
      }
    })

    assert_receive {:session_message, %{id: 2, type: :response, content: "Second step."}}
    refute_receive {:session_message_update, %{id: 1}}

    assert_messages(issue_id, session_id, [
      %{id: 1, type: :response, content: "First step."},
      %{id: 2, type: :response, content: "Second step."}
    ])
  end

  test "starts a new streamed message after item completion boundaries" do
    issue_id = unique_id("issue")
    session_id = unique_id("session")

    assert :ok = ObservabilityPubSub.subscribe_session(issue_id)
    start_session_log!(issue_id, session_id)

    now = DateTime.utc_now() |> DateTime.truncate(:second)

    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "codex/event/agent_message_delta",
        "params" => %{"msg" => %{"payload" => %{"delta" => "First"}}}
      }
    })

    assert_receive {:session_message, %{id: 1, type: :response, content: "First"}}

    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "codex/event/agent_message_delta",
        "params" => %{"msg" => %{"payload" => %{"delta" => " step"}}}
      }
    })

    assert_receive {:session_message_update, %{id: 1, type: :response, content: "First step"}}

    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "codex/event/item_completed",
        "params" => %{"msg" => %{"payload" => %{"type" => "agent_message"}}}
      }
    })

    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "codex/event/agent_message_delta",
        "params" => %{"msg" => %{"payload" => %{"delta" => "Second step"}}}
      }
    })

    assert_receive {:session_message, %{id: 2, type: :response, content: "Second step"}}

    assert_messages(issue_id, session_id, [
      %{id: 1, type: :response, content: "First step"},
      %{id: 2, type: :response, content: "Second step"}
    ])
  end

  test "only captures completed tool events, not running/requested ones" do
    issue_id = unique_id("issue")
    session_id = unique_id("session")

    assert :ok = ObservabilityPubSub.subscribe_session(issue_id)
    start_session_log!(issue_id, session_id)

    now = DateTime.utc_now() |> DateTime.truncate(:second)

    # Running/requested events should be ignored
    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "item/tool/call",
        "params" => %{
          "name" => "linear_graphql",
          "arguments" => %{"query" => "query Viewer { viewer { id } }"}
        }
      }
    })

    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "codex/event/exec_command_begin",
        "params" => %{"msg" => %{"command" => "git status --short", "cwd" => "/tmp/workspace"}}
      }
    })

    SessionLog.append(issue_id, session_id, %{
      event: :approval_auto_approved,
      timestamp: now,
      decision: "acceptForSession",
      payload: %{
        "method" => "item/commandExecution/requestApproval",
        "params" => %{"parsedCmd" => "mix test", "cwd" => "/tmp/workspace"}
      }
    })

    refute_receive {:session_message, _}

    # Completed events should be captured
    SessionLog.append(issue_id, session_id, %{
      event: :tool_call_completed,
      timestamp: now,
      payload: %{
        "params" => %{
          "name" => "linear_graphql",
          "arguments" => %{"query" => "query Viewer { viewer { id } }"}
        },
        "result" => %{"success" => true}
      }
    })

    assert_receive {:session_message,
                    %{
                      id: 1,
                      type: :tool_call,
                      content: "linear_graphql",
                      metadata: %{status: "completed", args: %{"query" => "query Viewer { viewer { id } }"}}
                    }}

    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "codex/event/exec_command_end",
        "params" => %{"msg" => %{"command" => "mix test", "exit_code" => 0}}
      }
    })

    assert_receive {:session_message,
                    %{
                      id: 2,
                      type: :tool_call,
                      content: "exec_command",
                      metadata: %{status: "completed", args: %{cmd: "mix test", exit_code: 0}}
                    }}

    assert_messages(issue_id, session_id, [
      %{id: 1, type: :tool_call, content: "linear_graphql"},
      %{id: 2, type: :tool_call, content: "exec_command"}
    ])
  end

  defp start_session_log!(issue_id, session_id) do
    {:ok, _pid} =
      SessionLog.start_link(
        issue_id: issue_id,
        session_id: session_id,
        issue_identifier: unique_id("SYM-26"),
        issue_title: "Session log test",
        project_id: nil
      )

    on_exit(fn ->
      try do
        SessionLog.stop(issue_id, session_id)
      catch
        :exit, _reason -> :ok
      end
    end)
  end

  defp assert_messages(issue_id, session_id, expected_messages) do
    eventually(fn ->
      {:ok, messages} = SessionLog.get_messages(issue_id, session_id)

      Enum.map(messages, fn message ->
        %{id: message.id, type: message.type, content: message.content}
      end) == expected_messages
    end)
  end

  defp eventually(fun, attempts \\ 20)

  defp eventually(fun, attempts) when attempts > 0 do
    if fun.() do
      :ok
    else
      Process.sleep(25)
      eventually(fun, attempts - 1)
    end
  end

  defp eventually(_fun, 0), do: flunk("condition was not met")

  defp unique_id(prefix), do: "#{prefix}-#{System.unique_integer([:positive])}"
end
