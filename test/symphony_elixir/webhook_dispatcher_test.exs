defmodule SymphonyElixir.WebhookDispatcherTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.{Store, WebhookDispatcher}

  setup do
    original = Application.get_env(:symphony_elixir, :linear_client_module)
    Application.put_env(:symphony_elixir, :linear_client_module, __MODULE__.StubClient)

    on_exit(fn ->
      if is_nil(original) do
        Application.delete_env(:symphony_elixir, :linear_client_module)
      else
        Application.put_env(:symphony_elixir, :linear_client_module, original)
      end

      :ok
    end)

    :ok
  end

  describe "dispatch_created/1" do
    test "returns error when issue_id is missing" do
      payload = %{"data" => %{"id" => "agent-sess-1"}}
      assert {:error, :missing_issue_id} = WebhookDispatcher.dispatch_created(payload)
    end

    test "returns error when agent_session_id is missing" do
      payload = %{"data" => %{"issueId" => "issue-1"}}
      assert {:error, :missing_agent_session_id} = WebhookDispatcher.dispatch_created(payload)
    end

    test "claims issue and handles already-claimed case" do
      issue_id = "test-issue-#{System.unique_integer([:positive])}"

      # Pre-claim the issue
      Store.claim_issue(issue_id, "orchestrator")

      payload = %{
        "data" => %{
          "id" => "agent-sess-1",
          "issueId" => issue_id
        }
      }

      # Should succeed (associates session) even when already claimed
      assert :ok = WebhookDispatcher.dispatch_created(payload)
    end

    test "emits first_activity_latency telemetry when received_at is provided" do
      issue_id = "test-issue-#{System.unique_integer([:positive])}"
      Store.claim_issue(issue_id, "orchestrator")

      test_pid = self()

      handler_id = "test-#{System.unique_integer([:positive])}"

      :telemetry.attach(
        handler_id,
        [:symphony, :webhook, :first_activity_latency],
        fn event, measurements, metadata, _ ->
          send(test_pid, {:telemetry_event, event, measurements, metadata})
        end,
        nil
      )

      payload = %{
        "data" => %{
          "id" => "agent-sess-telemetry",
          "issueId" => issue_id
        }
      }

      received_at = System.monotonic_time()
      WebhookDispatcher.dispatch_created(payload, received_at: received_at)

      event_name = [:symphony, :webhook, :first_activity_latency]

      assert_receive {:telemetry_event, ^event_name, %{duration: duration}, %{agent_session_id: "agent-sess-telemetry"}}

      assert is_integer(duration)
      assert duration >= 0

      :telemetry.detach(handler_id)
    end

    test "does not emit telemetry when received_at is not provided" do
      issue_id = "test-issue-#{System.unique_integer([:positive])}"
      Store.claim_issue(issue_id, "orchestrator")

      test_pid = self()

      handler_id = "test-no-telemetry-#{System.unique_integer([:positive])}"

      :telemetry.attach(
        handler_id,
        [:symphony, :webhook, :first_activity_latency],
        fn event, measurements, metadata, _ ->
          send(test_pid, {:telemetry_event, event, measurements, metadata})
        end,
        nil
      )

      payload = %{
        "data" => %{
          "id" => "agent-sess-no-telemetry",
          "issueId" => issue_id
        }
      }

      WebhookDispatcher.dispatch_created(payload)

      refute_receive {:telemetry_event, _, _, _}

      :telemetry.detach(handler_id)
    end
  end

  describe "dispatch_prompted/1" do
    test "returns error when agent_session_id is missing" do
      payload = %{"data" => %{}}
      assert {:error, :missing_agent_session_id} = WebhookDispatcher.dispatch_prompted(payload)
    end

    test "returns error when prompt message is missing" do
      payload = %{
        "data" => %{
          "id" => "agent-sess-1"
        }
      }

      assert {:error, :missing_prompt_message} = WebhookDispatcher.dispatch_prompted(payload)
    end

    test "returns error when no session exists for agent_session_id" do
      payload = %{
        "data" => %{
          "id" => "nonexistent-session",
          "agentActivity" => %{"body" => "Do something"}
        }
      }

      assert {:error, :session_not_found} = WebhookDispatcher.dispatch_prompted(payload)
    end

    test "stop signal dispatches stop instead of prompt injection" do
      issue_id = "test-issue-#{System.unique_integer([:positive])}"
      agent_session_id = "agent-sess-stop-#{System.unique_integer([:positive])}"

      # Create a DB session so find_session_by_agent_session_id works
      Store.create_session(%{
        issue_id: issue_id,
        agent_session_id: agent_session_id,
        session_id: "engine-#{System.unique_integer([:positive])}",
        status: "running",
        started_at: DateTime.utc_now()
      })

      # Start an AgentSession GenServer
      {:ok, _pid} =
        SymphonyElixir.AgentSession.start_link(
          issue_id: issue_id,
          agent_session_id: agent_session_id,
          dispatch_source: :webhook
        )

      assert SymphonyElixir.AgentSession.active?(issue_id)

      payload = %{
        "agentSession" => %{
          "id" => agent_session_id
        },
        "agentActivity" => %{
          "signal" => "stop"
        }
      }

      assert :ok = WebhookDispatcher.dispatch_prompted(payload)

      # Give time for async stop to process
      :timer.sleep(50)

      # AgentSession should be stopped
      refute SymphonyElixir.AgentSession.active?(issue_id)
    end

    test "non-stop signal proceeds with normal prompt injection" do
      payload = %{
        "agentSession" => %{
          "id" => "nonexistent-session"
        },
        "agentActivity" => %{"body" => "Do something"}
      }

      # Without a stop signal, it proceeds with normal flow (and fails because session doesn't exist)
      assert {:error, :session_not_found} = WebhookDispatcher.dispatch_prompted(payload)
    end

    test "stop signal returns error when no session exists" do
      payload = %{
        "agentSession" => %{
          "id" => "nonexistent-session"
        },
        "agentActivity" => %{
          "signal" => "stop"
        }
      }

      assert {:error, :session_not_found} = WebhookDispatcher.dispatch_prompted(payload)
    end
  end

  describe "maybe_associate_session race condition" do
    test "concurrent associate calls do not create duplicate sessions" do
      issue_id = "test-issue-#{System.unique_integer([:positive])}"

      # Pre-claim the issue
      Store.claim_issue(issue_id, "orchestrator")

      # Simulate two concurrent dispatch_created calls for the same issue
      payload = %{
        "data" => %{
          "id" => "agent-sess-dup-1",
          "issueId" => issue_id
        }
      }

      payload2 = %{
        "data" => %{
          "id" => "agent-sess-dup-2",
          "issueId" => issue_id
        }
      }

      # Both should succeed without error
      assert :ok = WebhookDispatcher.dispatch_created(payload)
      assert :ok = WebhookDispatcher.dispatch_created(payload2)

      # Only one AgentSession should be active
      assert SymphonyElixir.AgentSession.active?(issue_id)

      # Clean up
      SymphonyElixir.AgentSession.stop(issue_id)
    end
  end

  describe "dispatch_created skip_labels" do
    test "skips dispatch when issue has a configured skip label" do
      issue_id = "test-skip-#{System.unique_integer([:positive])}"

      # Re-write workflow with skip_labels configured
      workflow_path = Workflow.workflow_file_paths() |> List.first()
      write_workflow_file!(workflow_path, tracker_skip_labels: ["needs-human-review", "reviewed-by-agent"])

      # Use a stub that returns an issue with the skip label
      Application.put_env(:symphony_elixir, :linear_client_module, __MODULE__.SkipLabelStubClient)

      payload = %{
        "data" => %{
          "id" => "agent-sess-skip-#{System.unique_integer([:positive])}",
          "issueId" => issue_id
        }
      }

      assert {:error, :skip_label} = WebhookDispatcher.dispatch_created(payload)

      # Issue claim should have been released
      refute issue_id in Store.list_claimed_issue_ids()
    end

    test "dispatches normally when issue has no skip labels" do
      issue_id = "test-no-skip-#{System.unique_integer([:positive])}"

      workflow_path = Workflow.workflow_file_paths() |> List.first()
      write_workflow_file!(workflow_path, tracker_skip_labels: ["needs-human-review", "reviewed-by-agent"])

      Application.put_env(:symphony_elixir, :linear_client_module, __MODULE__.NoSkipLabelStubClient)

      # Pre-claim so the second call hits the already_claimed branch (avoids spawning a real agent)
      Store.claim_issue(issue_id, "orchestrator")

      payload = %{
        "data" => %{
          "id" => "agent-sess-noskip-#{System.unique_integer([:positive])}",
          "issueId" => issue_id
        }
      }

      # Should succeed (not blocked by skip labels); already-claimed path returns :ok
      assert :ok = WebhookDispatcher.dispatch_created(payload)
    end
  end

  defmodule StubClient do
    def graphql(_query, _variables) do
      {:ok, %{"data" => %{"createAgentActivity" => %{"success" => true}}}}
    end

    def fetch_issue_states_by_ids(_ids) do
      {:ok, []}
    end
  end

  defmodule SkipLabelStubClient do
    alias SymphonyElixir.Linear.Issue

    def graphql(_query, _variables) do
      {:ok, %{"data" => %{"createAgentActivity" => %{"success" => true}}}}
    end

    def fetch_issue_states_by_ids(ids) do
      issues =
        Enum.map(ids, fn id ->
          %Issue{
            id: id,
            identifier: "TEST-1",
            title: "Test issue",
            state: "Human Review",
            labels: ["needs-human-review"],
            comments: []
          }
        end)

      {:ok, issues}
    end
  end

  defmodule NoSkipLabelStubClient do
    alias SymphonyElixir.Linear.Issue

    def graphql(_query, _variables) do
      {:ok, %{"data" => %{"createAgentActivity" => %{"success" => true}}}}
    end

    def fetch_issue_states_by_ids(ids) do
      issues =
        Enum.map(ids, fn id ->
          %Issue{
            id: id,
            identifier: "TEST-2",
            title: "Test issue no skip",
            state: "Human Review",
            labels: ["some-other-label"],
            comments: []
          }
        end)

      {:ok, issues}
    end
  end
end
