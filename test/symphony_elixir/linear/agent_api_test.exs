defmodule SymphonyElixir.Linear.AgentAPITest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Linear.AgentAPI

  defmodule MockClient do
    def graphql(query, variables) do
      send(self(), {:graphql_called, query, variables})

      case Process.get({__MODULE__, :graphql_result}) do
        nil -> {:error, :no_mock_result}
        result -> result
      end
    end
  end

  setup do
    original = Application.get_env(:symphony_elixir, :linear_client_module)
    Application.put_env(:symphony_elixir, :linear_client_module, MockClient)

    on_exit(fn ->
      if is_nil(original) do
        Application.delete_env(:symphony_elixir, :linear_client_module)
      else
        Application.put_env(:symphony_elixir, :linear_client_module, original)
      end
    end)

    :ok
  end

  describe "create_session_on_issue/1" do
    test "returns agent session id on success" do
      Process.put(
        {MockClient, :graphql_result},
        {:ok,
         %{
           "data" => %{
             "agentSessionCreateOnIssue" => %{
               "success" => true,
               "agentSession" => %{"id" => "session-abc-123"}
             }
           }
         }}
      )

      assert {:ok, "session-abc-123"} = AgentAPI.create_session_on_issue("issue-1")

      assert_receive {:graphql_called, query, %{issueId: "issue-1"}}
      assert query =~ "agentSessionCreateOnIssue"
    end

    test "returns error on failure" do
      Process.put(
        {MockClient, :graphql_result},
        {:ok,
         %{
           "data" => %{
             "agentSessionCreateOnIssue" => %{"success" => false}
           }
         }}
      )

      assert {:error, :session_create_failed} = AgentAPI.create_session_on_issue("issue-1")
    end

    test "returns error on network failure" do
      Process.put({MockClient, :graphql_result}, {:error, :timeout})

      assert {:error, :timeout} = AgentAPI.create_session_on_issue("issue-1")
    end
  end

  describe "create_activity/2" do
    test "returns :ok on success" do
      Process.put(
        {MockClient, :graphql_result},
        {:ok,
         %{
           "data" => %{
             "createAgentActivity" => %{"success" => true}
           }
         }}
      )

      content = %{type: "thought", body: "Analyzing issue..."}

      assert :ok = AgentAPI.create_activity("session-abc", content)

      assert_receive {:graphql_called, query, %{agentSessionId: "session-abc", content: ^content}}
      assert query =~ "createAgentActivity"
    end

    test "returns error on failure" do
      Process.put(
        {MockClient, :graphql_result},
        {:ok,
         %{
           "data" => %{
             "createAgentActivity" => %{"success" => false}
           }
         }}
      )

      assert {:error, :activity_create_failed} =
               AgentAPI.create_activity("session-abc", %{type: "thought", body: "test"})
    end
  end

  describe "update_session/2" do
    test "sends plan update on success" do
      Process.put(
        {MockClient, :graphql_result},
        {:ok,
         %{
           "data" => %{
             "agentSessionUpdate" => %{"success" => true}
           }
         }}
      )

      plan = [
        %{content: "Analyze issue", status: "inProgress"},
        %{content: "Implement changes", status: "pending"}
      ]

      assert :ok = AgentAPI.update_session("session-abc", plan: plan)

      assert_receive {:graphql_called, query, %{id: "session-abc", input: input}}
      assert query =~ "agentSessionUpdate"
      assert input.plan == plan
    end

    test "sends external urls on success" do
      Process.put(
        {MockClient, :graphql_result},
        {:ok,
         %{
           "data" => %{
             "agentSessionUpdate" => %{"success" => true}
           }
         }}
      )

      urls = [%{label: "Dashboard", url: "https://example.com"}]

      assert :ok = AgentAPI.update_session("session-abc", added_external_urls: urls)

      assert_receive {:graphql_called, _query, %{input: input}}
      assert input.addedExternalUrls == urls
      refute Map.has_key?(input, :plan)
    end

    test "returns error on failure" do
      Process.put(
        {MockClient, :graphql_result},
        {:ok,
         %{
           "data" => %{
             "agentSessionUpdate" => %{"success" => false}
           }
         }}
      )

      assert {:error, :session_update_failed} =
               AgentAPI.update_session("session-abc", plan: [])
    end
  end
end
