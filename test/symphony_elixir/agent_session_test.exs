defmodule SymphonyElixir.AgentSessionTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.AgentSession

  defmodule MockLinearClient do
    def graphql(query, variables) do
      test_pid = Application.get_env(:symphony_elixir, :agent_session_test_pid)
      if test_pid, do: send(test_pid, {:graphql_called, query, variables})

      {:ok,
       %{
         "data" => %{
           "createAgentActivity" => %{"success" => true},
           "agentSessionUpdate" => %{"success" => true}
         }
       }}
    end
  end

  setup do
    prev = Application.get_env(:symphony_elixir, :linear_client_module)
    Application.put_env(:symphony_elixir, :linear_client_module, MockLinearClient)
    Application.put_env(:symphony_elixir, :agent_session_test_pid, self())

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :agent_session_test_pid)

      if is_nil(prev) do
        Application.delete_env(:symphony_elixir, :linear_client_module)
      else
        Application.put_env(:symphony_elixir, :linear_client_module, prev)
      end
    end)

    :ok
  end

  defp start_session(issue_id, opts \\ []) do
    agent_session_id = Keyword.get(opts, :agent_session_id, "agent-sess-#{issue_id}")

    {:ok, pid} =
      AgentSession.start_link(
        issue_id: issue_id,
        agent_session_id: agent_session_id,
        dispatch_source: Keyword.get(opts, :dispatch_source)
      )

    pid
  end

  describe "start_link/1 and active?/1" do
    test "starts and registers by issue_id" do
      issue_id = "issue-#{System.unique_integer([:positive])}"
      pid = start_session(issue_id)

      assert Process.alive?(pid)
      assert AgentSession.active?(issue_id)
    end

    test "active? returns false for unknown issue" do
      refute AgentSession.active?("nonexistent-issue")
    end

    test "prevents duplicate registration" do
      issue_id = "issue-#{System.unique_integer([:positive])}"
      _pid = start_session(issue_id)

      assert {:error, {:already_started, _}} =
               AgentSession.start_link(
                 issue_id: issue_id,
                 agent_session_id: "agent-sess-dup"
               )
    end
  end

  describe "stop/1" do
    test "stops the GenServer" do
      issue_id = "issue-#{System.unique_integer([:positive])}"
      pid = start_session(issue_id)

      assert AgentSession.active?(issue_id)
      :ok = AgentSession.stop(issue_id)

      refute Process.alive?(pid)
      # Registry cleanup is async; wait briefly for monitor to fire
      Process.sleep(10)
      refute AgentSession.active?(issue_id)
    end

    test "stop on nonexistent issue is a no-op" do
      assert :ok = AgentSession.stop("nonexistent")
    end
  end

  describe "inject_prompt/2 and drain_pending_prompts/1" do
    test "queues and drains messages in order" do
      issue_id = "issue-#{System.unique_integer([:positive])}"
      _pid = start_session(issue_id)

      AgentSession.inject_prompt(issue_id, "first message")
      AgentSession.inject_prompt(issue_id, "second message")

      messages = AgentSession.drain_pending_prompts(issue_id)
      assert messages == ["first message", "second message"]
    end

    test "drain clears the queue" do
      issue_id = "issue-#{System.unique_integer([:positive])}"
      _pid = start_session(issue_id)

      AgentSession.inject_prompt(issue_id, "msg")
      assert AgentSession.drain_pending_prompts(issue_id) == ["msg"]
      assert AgentSession.drain_pending_prompts(issue_id) == []
    end

    test "drain on nonexistent issue returns empty list" do
      assert AgentSession.drain_pending_prompts("nonexistent") == []
    end

    test "inject on nonexistent issue is a no-op" do
      assert :ok = AgentSession.inject_prompt("nonexistent", "msg")
    end
  end

  describe "emit_activity/2" do
    test "sends activity to AgentAPI" do
      issue_id = "issue-#{System.unique_integer([:positive])}"
      _pid = start_session(issue_id)

      AgentSession.emit_activity(issue_id, %{type: :thought, body: "Thinking..."})

      # Give async task time to execute
      Process.sleep(50)

      assert_received {:graphql_called, query, %{content: content}}
      assert query =~ "createAgentActivity"
      decoded = Jason.decode!(content)
      assert decoded["type"] == "thought"
      assert decoded["body"] == "Thinking..."
    end

    test "emit on nonexistent issue is a no-op" do
      assert :ok = AgentSession.emit_activity("nonexistent", %{type: :thought, body: "test"})
    end
  end

  describe "rate limiting" do
    test "buffers rapid activities and flushes with delay" do
      issue_id = "issue-#{System.unique_integer([:positive])}"
      _pid = start_session(issue_id)

      # Emit three activities rapidly
      AgentSession.emit_activity(issue_id, %{type: :thought, body: "first"})
      AgentSession.emit_activity(issue_id, %{type: :thought, body: "second"})
      AgentSession.emit_activity(issue_id, %{type: :thought, body: "third"})

      # First should be sent immediately
      Process.sleep(50)
      assert_received {:graphql_called, _query, %{content: content1}}
      decoded1 = Jason.decode!(content1)
      assert decoded1["body"] == "first"

      # Second should not be sent yet (within rate limit)
      refute_received {:graphql_called, _, _}

      # Wait for rate limit to pass
      Process.sleep(550)

      # Second should now be sent
      assert_received {:graphql_called, _query, %{content: content2}}
      decoded2 = Jason.decode!(content2)
      assert decoded2["body"] == "second"

      # Wait for third
      Process.sleep(550)
      assert_received {:graphql_called, _query, %{content: content3}}
      decoded3 = Jason.decode!(content3)
      assert decoded3["body"] == "third"
    end
  end

  describe "update_plan/2" do
    test "sends plan to AgentAPI" do
      issue_id = "issue-#{System.unique_integer([:positive])}"
      _pid = start_session(issue_id)

      plan = [
        %{title: "Step 1", status: :pending},
        %{title: "Step 2", status: :in_progress}
      ]

      AgentSession.update_plan(issue_id, plan)

      Process.sleep(50)

      assert_received {:graphql_called, query, %{plan: plan_json}}
      assert query =~ "agentSessionUpdate"
      decoded = Jason.decode!(plan_json)
      assert length(decoded) == 2
      assert hd(decoded)["title"] == "Step 1"
      assert hd(decoded)["status"] == "pending"
    end

    test "update_plan on nonexistent issue is a no-op" do
      assert :ok = AgentSession.update_plan("nonexistent", [])
    end
  end

  describe "set_external_urls/2" do
    test "sends URLs to AgentAPI" do
      issue_id = "issue-#{System.unique_integer([:positive])}"
      _pid = start_session(issue_id)

      urls = ["https://github.com/org/repo/pull/1"]
      AgentSession.set_external_urls(issue_id, urls)

      Process.sleep(50)

      assert_received {:graphql_called, query, variables}
      assert query =~ "agentSessionUpdate"
      assert variables.externalUrls == urls
    end

    test "set_external_urls on nonexistent issue is a no-op" do
      assert :ok = AgentSession.set_external_urls("nonexistent", [])
    end
  end
end
