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

  test "session creation populates workflow field" do
    issue_id = unique_id("issue")
    session_id = unique_id("session")

    start_session_log!(issue_id, session_id, workflow_name: "MY_WORKFLOW")

    sessions = SymphonyElixir.Store.list_sessions(limit: 100)
    session = Enum.find(sessions, &(&1.issue_id == issue_id))

    assert session != nil
    assert session.workflow == "MY_WORKFLOW"
    assert session.workflow_name == "MY_WORKFLOW"
  end

  test "finalize computes estimated_cost_cents using Pricing when model is configured" do
    issue_id = unique_id("issue")
    session_id = unique_id("session")

    # Write workflow with claude.model so Pricing can compute a real cost
    workflow_root = Path.join(System.tmp_dir!(), "sym-173-cost-#{System.unique_integer([:positive])}")
    File.mkdir_p!(workflow_root)
    workflow_file = Path.join(workflow_root, "WORKFLOW.md")
    write_workflow_file!(workflow_file)
    content = File.read!(workflow_file)
    # Insert claude section before closing "---" delimiter
    [front, rest] = String.split(content, "\n---\n", parts: 2)
    File.write!(workflow_file, front <> "\nclaude:\n  model: \"claude-sonnet-4-6\"\n---\n" <> rest)
    SymphonyElixir.Workflow.set_workflow_file_path(workflow_file)
    if Process.whereis(SymphonyElixir.WorkflowStore), do: SymphonyElixir.WorkflowStore.force_reload()

    start_session_log!(issue_id, session_id)

    # 500K input at 300/MTok = 150, 200K output at 1500/MTok = 300 → 450 cents
    assert :ok =
             SessionLog.finalize(issue_id, session_id, :completed, %{
               input_tokens: 500_000,
               output_tokens: 200_000
             })

    sessions = SymphonyElixir.Store.list_sessions(limit: 100)
    session = Enum.find(sessions, &(&1.issue_id == issue_id))

    assert session != nil
    assert session.estimated_cost_cents == 450
    assert session.status == "completed"

    on_exit(fn -> File.rm_rf(workflow_root) end)
  end

  test "finalize defaults estimated_cost_cents to 0 and logs warning when model unavailable" do
    issue_id = unique_id("issue")
    session_id = unique_id("session")

    start_session_log!(issue_id, session_id)

    # Default test workflow has no claude.model configured
    log =
      capture_log(fn ->
        assert :ok =
                 SessionLog.finalize(issue_id, session_id, :completed, %{
                   input_tokens: 500_000,
                   output_tokens: 200_000
                 })
      end)

    assert log =~ "Model name unavailable"

    sessions = SymphonyElixir.Store.list_sessions(limit: 100)
    session = Enum.find(sessions, &(&1.issue_id == issue_id))

    assert session != nil
    assert session.estimated_cost_cents == 0
    assert session.status == "completed"
  end

  test "finalize preserves caller-provided estimated_cost_cents" do
    issue_id = unique_id("issue")
    session_id = unique_id("session")

    start_session_log!(issue_id, session_id)

    assert :ok =
             SessionLog.finalize(issue_id, session_id, :completed, %{
               estimated_cost_cents: 999
             })

    sessions = SymphonyElixir.Store.list_sessions(limit: 100)
    session = Enum.find(sessions, &(&1.issue_id == issue_id))

    assert session != nil
    assert session.estimated_cost_cents == 999
  end

  test "finalize passes stderr to Store.complete_session" do
    issue_id = unique_id("issue")
    session_id = unique_id("session")

    start_session_log!(issue_id, session_id)

    stderr_content = "error: something went wrong\nstack trace here"
    assert :ok = SessionLog.finalize(issue_id, session_id, :completed, %{stderr: stderr_content})

    # Verify stderr was persisted via Store — list sessions and find ours by issue_id
    sessions = SymphonyElixir.Store.list_sessions(limit: 100)
    session = Enum.find(sessions, &(&1.issue_id == issue_id))

    assert session != nil
    assert session.stderr == stderr_content
    assert session.status == "completed"
  end

  test "store_stderr persists stderr without changing session status" do
    issue_id = unique_id("issue")
    session_id = unique_id("session")

    start_session_log!(issue_id, session_id)

    stderr_content = "warning: deprecation notice\nsome debug output"
    assert :ok = SessionLog.store_stderr(issue_id, session_id, stderr_content)

    # Verify stderr was persisted but status remains "running" (not completed)
    sessions = SymphonyElixir.Store.list_sessions(limit: 100)
    session = Enum.find(sessions, &(&1.issue_id == issue_id))

    assert session != nil
    assert session.stderr == stderr_content
    assert session.status == "running"
  end

  test "claude code tool_use and tool_result are correlated by tool_use_id" do
    issue_id = unique_id("issue")
    session_id = unique_id("session")

    assert :ok = ObservabilityPubSub.subscribe_session(issue_id)
    start_session_log!(issue_id, session_id)

    now = DateTime.utc_now() |> DateTime.truncate(:second)

    # tool_use: starts a Read call
    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "claude/tool_use",
        "params" => %{
          "id" => "toolu_abc123",
          "name" => "Read",
          "input" => %{"file_path" => "/tmp/foo.ex", "limit" => 50}
        }
      }
    })

    assert_receive {:session_message,
                    %{
                      id: 1,
                      type: :tool_call,
                      content: "Read",
                      metadata: %{status: "started", args: %{"file_path" => "/tmp/foo.ex", "limit" => 50}}
                    }}

    # An intervening non-tool message (e.g. assistant text) that would reset last_tool_call
    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "claude/assistant_message",
        "params" => %{"content" => "Reading the file now."}
      }
    })

    assert_receive {:session_message, %{id: 2, type: :response, content: "Reading the file now."}}

    # tool_result: arrives with tool_use_id, should merge into message #1
    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "claude/tool_result",
        "params" => %{
          "tool_use_id" => "toolu_abc123",
          "content" => "defmodule Foo do\n  def bar, do: :ok\nend"
        }
      }
    })

    assert_receive {:session_message_update,
                    %{
                      id: 1,
                      type: :tool_call,
                      content: "Read",
                      metadata: %{status: "completed", result: _result}
                    }}

    # Only 2 messages total: the tool_call and the response (no separate completion message)
    assert_messages(issue_id, session_id, [
      %{id: 1, type: :tool_call, content: "Read"},
      %{id: 2, type: :response, content: "Reading the file now."}
    ])
  end

  test "claude code parallel tool calls are tracked independently" do
    issue_id = unique_id("issue")
    session_id = unique_id("session")

    assert :ok = ObservabilityPubSub.subscribe_session(issue_id)
    start_session_log!(issue_id, session_id)

    now = DateTime.utc_now() |> DateTime.truncate(:second)

    # Two tool_use events for the same tool name but different IDs
    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "claude/tool_use",
        "params" => %{
          "id" => "toolu_read1",
          "name" => "Read",
          "input" => %{"file_path" => "/tmp/a.ex"}
        }
      }
    })

    assert_receive {:session_message, %{id: 1, type: :tool_call, content: "Read"}}

    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "claude/tool_use",
        "params" => %{
          "id" => "toolu_read2",
          "name" => "Read",
          "input" => %{"file_path" => "/tmp/b.ex"}
        }
      }
    })

    # Should create a second message, NOT merge into the first
    assert_receive {:session_message, %{id: 2, type: :tool_call, content: "Read"}}

    # Results arrive in reverse order
    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "claude/tool_result",
        "params" => %{
          "tool_use_id" => "toolu_read2",
          "content" => "file b content"
        }
      }
    })

    assert_receive {:session_message_update, %{id: 2, metadata: %{status: "completed"}}}

    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "claude/tool_result",
        "params" => %{
          "tool_use_id" => "toolu_read1",
          "content" => "file a content"
        }
      }
    })

    assert_receive {:session_message_update, %{id: 1, metadata: %{status: "completed"}}}

    # Two distinct tool_call messages
    assert_messages(issue_id, session_id, [
      %{id: 1, type: :tool_call, content: "Read"},
      %{id: 2, type: :tool_call, content: "Read"}
    ])
  end

  test "claude code tool_result extracts result from content block list" do
    issue_id = unique_id("issue")
    session_id = unique_id("session")

    assert :ok = ObservabilityPubSub.subscribe_session(issue_id)
    start_session_log!(issue_id, session_id)

    now = DateTime.utc_now() |> DateTime.truncate(:second)

    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "claude/tool_use",
        "params" => %{"id" => "toolu_list1", "name" => "Bash", "input" => %{"command" => "ls"}}
      }
    })

    assert_receive {:session_message, %{id: 1}}

    # tool_result with content as a list of content blocks
    SessionLog.append(issue_id, session_id, %{
      event: :notification,
      timestamp: now,
      payload: %{
        "method" => "claude/tool_result",
        "params" => %{
          "tool_use_id" => "toolu_list1",
          "content" => [%{"type" => "text", "text" => "file1.ex\nfile2.ex"}]
        }
      }
    })

    assert_receive {:session_message_update, %{id: 1, metadata: %{status: "completed", result: "file1.ex\nfile2.ex"}}}
  end

  defp start_session_log!(issue_id, session_id, opts \\ []) do
    workflow_name = Keyword.get(opts, :workflow_name)

    {:ok, _pid} =
      SessionLog.start_link(
        [
          issue_id: issue_id,
          session_id: session_id,
          issue_identifier: unique_id("SYM-26"),
          issue_title: "Session log test",
          project_id: nil,
          organization_id: test_org_id()
        ] ++ if(workflow_name, do: [workflow_name: workflow_name], else: [])
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
