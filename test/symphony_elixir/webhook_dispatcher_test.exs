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

      assert_receive {:telemetry_event, [:symphony, :webhook, :first_activity_latency], %{duration: duration}, %{agent_session_id: "agent-sess-telemetry"}}

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
  end

  defmodule StubClient do
    def graphql(_query, _variables) do
      {:ok, %{"data" => %{"createAgentActivity" => %{"success" => true}}}}
    end

    def fetch_issue_states_by_ids(_ids) do
      {:ok, []}
    end
  end
end
