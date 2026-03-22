defmodule SymphonyElixir.Linear.AgentAPITest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Linear.AgentAPI

  defmodule MockLinearClient do
    def graphql(query, variables) do
      send(self(), {:graphql_called, query, variables})

      case Process.get({__MODULE__, :graphql_results}) do
        [result | rest] ->
          Process.put({__MODULE__, :graphql_results}, rest)
          result

        _ ->
          Process.get({__MODULE__, :graphql_result})
      end
    end
  end

  setup do
    prev = Application.get_env(:symphony_elixir, :linear_client_module)
    Application.put_env(:symphony_elixir, :linear_client_module, MockLinearClient)

    on_exit(fn ->
      if is_nil(prev) do
        Application.delete_env(:symphony_elixir, :linear_client_module)
      else
        Application.put_env(:symphony_elixir, :linear_client_module, prev)
      end
    end)

    :ok
  end

  describe "create_session_on_issue/1" do
    test "returns agent session id on success" do
      Process.put({MockLinearClient, :graphql_result}, {
        :ok,
        %{
          "data" => %{
            "agentSessionCreateOnIssue" => %{
              "success" => true,
              "agentSession" => %{"id" => "agent-session-123"}
            }
          }
        }
      })

      assert {:ok, "agent-session-123"} = AgentAPI.create_session_on_issue("issue-1")

      assert_received {:graphql_called, query, %{issueId: "issue-1"}}
      assert query =~ "agentSessionCreateOnIssue"
    end

    test "returns error when mutation fails" do
      Process.put({MockLinearClient, :graphql_result}, {
        :ok,
        %{
          "data" => %{
            "agentSessionCreateOnIssue" => %{
              "success" => false
            }
          }
        }
      })

      assert {:error, :agent_session_create_failed} = AgentAPI.create_session_on_issue("issue-1")
    end

    test "returns error on GraphQL transport failure" do
      Process.put({MockLinearClient, :graphql_result}, {:error, :timeout})

      assert {:error, :timeout} = AgentAPI.create_session_on_issue("issue-1")
    end
  end

  describe "create_activity/2" do
    test "sends thought activity" do
      Process.put({MockLinearClient, :graphql_result}, {
        :ok,
        %{"data" => %{"createAgentActivity" => %{"success" => true}}}
      })

      assert :ok = AgentAPI.create_activity("session-1", %{type: :thought, body: "Thinking..."})

      assert_received {:graphql_called, query, %{sessionId: "session-1", content: content}}
      assert query =~ "createAgentActivity"
      decoded = Jason.decode!(content)
      assert decoded["type"] == "thought"
      assert decoded["body"] == "Thinking..."
    end

    test "sends ephemeral thought activity" do
      Process.put({MockLinearClient, :graphql_result}, {
        :ok,
        %{"data" => %{"createAgentActivity" => %{"success" => true}}}
      })

      assert :ok =
               AgentAPI.create_activity("session-1", %{
                 type: :thought,
                 body: "Ephemeral thought",
                 ephemeral: true
               })

      assert_received {:graphql_called, _query, %{content: content}}
      decoded = Jason.decode!(content)
      assert decoded["ephemeral"] == true
    end

    test "sends action activity with result" do
      Process.put({MockLinearClient, :graphql_result}, {
        :ok,
        %{"data" => %{"createAgentActivity" => %{"success" => true}}}
      })

      assert :ok =
               AgentAPI.create_activity("session-1", %{
                 type: :action,
                 action: "edit_file",
                 parameter: "lib/foo.ex",
                 result: "File updated"
               })

      assert_received {:graphql_called, _query, %{content: content}}
      decoded = Jason.decode!(content)
      assert decoded["type"] == "action"
      assert decoded["action"] == "edit_file"
      assert decoded["parameter"] == "lib/foo.ex"
      assert decoded["result"] == "File updated"
    end

    test "sends response activity" do
      Process.put({MockLinearClient, :graphql_result}, {
        :ok,
        %{"data" => %{"createAgentActivity" => %{"success" => true}}}
      })

      assert :ok = AgentAPI.create_activity("session-1", %{type: :response, body: "Done!"})

      assert_received {:graphql_called, _query, %{content: content}}
      decoded = Jason.decode!(content)
      assert decoded["type"] == "response"
      assert decoded["body"] == "Done!"
    end

    test "sends error activity" do
      Process.put({MockLinearClient, :graphql_result}, {
        :ok,
        %{"data" => %{"createAgentActivity" => %{"success" => true}}}
      })

      assert :ok = AgentAPI.create_activity("session-1", %{type: :error, body: "Something failed"})

      assert_received {:graphql_called, _query, %{content: content}}
      decoded = Jason.decode!(content)
      assert decoded["type"] == "error"
    end

    test "sends elicitation activity" do
      Process.put({MockLinearClient, :graphql_result}, {
        :ok,
        %{"data" => %{"createAgentActivity" => %{"success" => true}}}
      })

      assert :ok =
               AgentAPI.create_activity("session-1", %{type: :elicitation, body: "Need input"})

      assert_received {:graphql_called, _query, %{content: content}}
      decoded = Jason.decode!(content)
      assert decoded["type"] == "elicitation"
      assert decoded["body"] == "Need input"
    end

    test "returns error when mutation fails" do
      Process.put({MockLinearClient, :graphql_result}, {
        :ok,
        %{"data" => %{"createAgentActivity" => %{"success" => false}}}
      })

      assert {:error, :agent_activity_create_failed} =
               AgentAPI.create_activity("session-1", %{type: :thought, body: "test"})
    end
  end

  describe "update_session/2" do
    test "updates session with plan" do
      Process.put({MockLinearClient, :graphql_result}, {
        :ok,
        %{"data" => %{"agentSessionUpdate" => %{"success" => true}}}
      })

      assert :ok = AgentAPI.update_session("session-1", plan: "Step 1: do things")

      assert_received {:graphql_called, query, variables}
      assert query =~ "agentSessionUpdate"
      assert variables.plan == "Step 1: do things"
      refute Map.has_key?(variables, :externalUrls)
    end

    test "updates session with external URLs" do
      Process.put({MockLinearClient, :graphql_result}, {
        :ok,
        %{"data" => %{"agentSessionUpdate" => %{"success" => true}}}
      })

      urls = ["https://github.com/org/repo/pull/1"]
      assert :ok = AgentAPI.update_session("session-1", external_urls: urls)

      assert_received {:graphql_called, _query, variables}
      assert variables.externalUrls == urls
      refute Map.has_key?(variables, :plan)
    end

    test "updates session with both plan and external URLs" do
      Process.put({MockLinearClient, :graphql_result}, {
        :ok,
        %{"data" => %{"agentSessionUpdate" => %{"success" => true}}}
      })

      assert :ok =
               AgentAPI.update_session("session-1",
                 plan: "My plan",
                 external_urls: ["https://example.com"]
               )

      assert_received {:graphql_called, _query, variables}
      assert variables.plan == "My plan"
      assert variables.externalUrls == ["https://example.com"]
    end

    test "updates session with no options" do
      Process.put({MockLinearClient, :graphql_result}, {
        :ok,
        %{"data" => %{"agentSessionUpdate" => %{"success" => true}}}
      })

      assert :ok = AgentAPI.update_session("session-1")

      assert_received {:graphql_called, _query, variables}
      assert variables.sessionId == "session-1"
      refute Map.has_key?(variables, :plan)
      refute Map.has_key?(variables, :externalUrls)
    end

    test "returns error when mutation fails" do
      Process.put({MockLinearClient, :graphql_result}, {
        :ok,
        %{"data" => %{"agentSessionUpdate" => %{"success" => false}}}
      })

      assert {:error, :agent_session_update_failed} =
               AgentAPI.update_session("session-1", plan: "test")
    end

    test "returns error on GraphQL transport failure" do
      Process.put({MockLinearClient, :graphql_result}, {:error, {:linear_api_request, :timeout}})

      assert {:error, {:linear_api_request, :timeout}} =
               AgentAPI.update_session("session-1", plan: "test")
    end
  end
end
