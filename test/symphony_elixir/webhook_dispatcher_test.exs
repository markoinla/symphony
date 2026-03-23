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
