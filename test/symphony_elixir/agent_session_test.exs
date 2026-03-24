defmodule SymphonyElixir.AgentSessionTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.AgentSession

  setup do
    # Override AgentAPI calls to use our mock via the client module
    original = Application.get_env(:symphony_elixir, :linear_client_module)

    # We mock at the AgentAPI level by replacing the Linear.Client graphql
    # responses. Set up process-level mock results for all API calls.
    on_exit(fn ->
      if is_nil(original) do
        Application.delete_env(:symphony_elixir, :linear_client_module)
      else
        Application.put_env(:symphony_elixir, :linear_client_module, original)
      end
    end)

    :ok
  end

  describe "start_link/1 and active?/1" do
    test "starts and registers with the correct issue_id" do
      issue_id = "test-issue-#{System.unique_integer([:positive])}"

      # Mock the GraphQL client for plan update on init
      Application.put_env(:symphony_elixir, :linear_client_module, __MODULE__.StubClient)

      {:ok, pid} =
        AgentSession.start_link(
          issue_id: issue_id,
          agent_session_id: "agent-sess-1"
        )

      assert AgentSession.active?(issue_id)
      assert Process.alive?(pid)

      GenServer.stop(pid)
      :timer.sleep(10)
      refute AgentSession.active?(issue_id)
    end
  end

  describe "inject_prompt/2 and drain_pending_prompts/1" do
    test "queues and drains prompts in order" do
      issue_id = "test-issue-#{System.unique_integer([:positive])}"
      Application.put_env(:symphony_elixir, :linear_client_module, __MODULE__.StubClient)

      {:ok, pid} =
        AgentSession.start_link(
          issue_id: issue_id,
          agent_session_id: "agent-sess-2"
        )

      AgentSession.inject_prompt(issue_id, "First message")
      AgentSession.inject_prompt(issue_id, "Second message")

      # Give casts time to process
      :timer.sleep(10)

      prompts = AgentSession.drain_pending_prompts(issue_id)
      assert prompts == ["First message", "Second message"]

      # Drain again should be empty
      assert AgentSession.drain_pending_prompts(issue_id) == []

      GenServer.stop(pid)
    end

    test "drain returns empty list when no session exists" do
      assert AgentSession.drain_pending_prompts("nonexistent-issue") == []
    end
  end

  describe "get_agent_session_id/1" do
    test "returns the agent session id" do
      issue_id = "test-issue-#{System.unique_integer([:positive])}"
      Application.put_env(:symphony_elixir, :linear_client_module, __MODULE__.StubClient)

      {:ok, pid} =
        AgentSession.start_link(
          issue_id: issue_id,
          agent_session_id: "agent-sess-abc"
        )

      assert AgentSession.get_agent_session_id(issue_id) == "agent-sess-abc"

      GenServer.stop(pid)
    end

    test "returns nil when no session exists" do
      assert AgentSession.get_agent_session_id("nonexistent") == nil
    end
  end

  describe "stop/1" do
    test "stops the GenServer" do
      issue_id = "test-issue-#{System.unique_integer([:positive])}"
      Application.put_env(:symphony_elixir, :linear_client_module, __MODULE__.StubClient)

      {:ok, _pid} =
        AgentSession.start_link(
          issue_id: issue_id,
          agent_session_id: "agent-sess-3"
        )

      assert AgentSession.active?(issue_id)
      AgentSession.stop(issue_id)

      # Give time for process to terminate
      :timer.sleep(10)
      refute AgentSession.active?(issue_id)
    end

    test "stop on nonexistent session is a no-op" do
      assert AgentSession.stop("nonexistent") == :ok
    end
  end

  describe "complete/2" do
    test "sends stop signal and stops the GenServer on :completed" do
      issue_id = "test-issue-#{System.unique_integer([:positive])}"
      Application.put_env(:symphony_elixir, :linear_client_module, __MODULE__.StubClient)

      {:ok, _pid} =
        AgentSession.start_link(
          issue_id: issue_id,
          agent_session_id: "agent-sess-complete"
        )

      assert AgentSession.active?(issue_id)
      AgentSession.complete(issue_id, :completed)

      :timer.sleep(10)
      refute AgentSession.active?(issue_id)
    end

    test "sends stop signal and stops the GenServer on :failed" do
      issue_id = "test-issue-#{System.unique_integer([:positive])}"
      Application.put_env(:symphony_elixir, :linear_client_module, __MODULE__.StubClient)

      {:ok, _pid} =
        AgentSession.start_link(
          issue_id: issue_id,
          agent_session_id: "agent-sess-fail"
        )

      assert AgentSession.active?(issue_id)
      AgentSession.complete(issue_id, :failed)

      :timer.sleep(10)
      refute AgentSession.active?(issue_id)
    end

    test "sends stop signal and stops the GenServer on :stopped" do
      issue_id = "test-issue-#{System.unique_integer([:positive])}"
      Application.put_env(:symphony_elixir, :linear_client_module, __MODULE__.StubClient)

      {:ok, _pid} =
        AgentSession.start_link(
          issue_id: issue_id,
          agent_session_id: "agent-sess-stopped"
        )

      assert AgentSession.active?(issue_id)
      AgentSession.complete(issue_id, :stopped)

      :timer.sleep(10)
      refute AgentSession.active?(issue_id)
    end

    test "complete on nonexistent session is a no-op" do
      assert AgentSession.complete("nonexistent", :completed) == :ok
    end
  end

  describe "runner_pid tracking" do
    test "set_runner_pid/2 and get_runner_pid/1 store and retrieve the runner PID" do
      issue_id = "test-issue-#{System.unique_integer([:positive])}"
      Application.put_env(:symphony_elixir, :linear_client_module, __MODULE__.StubClient)

      {:ok, pid} =
        AgentSession.start_link(
          issue_id: issue_id,
          agent_session_id: "agent-sess-runner"
        )

      assert AgentSession.get_runner_pid(issue_id) == nil

      AgentSession.set_runner_pid(issue_id, self())
      :timer.sleep(10)

      assert AgentSession.get_runner_pid(issue_id) == self()

      GenServer.stop(pid)
    end

    test "get_runner_pid returns nil when no session exists" do
      assert AgentSession.get_runner_pid("nonexistent") == nil
    end
  end

  describe "safe_cast behavior" do
    test "emit_activity on nonexistent session is a no-op" do
      assert AgentSession.emit_activity("nonexistent", %{event: :session_started}) == :ok
    end

    test "inject_prompt on nonexistent session is a no-op" do
      assert AgentSession.inject_prompt("nonexistent", "hello") == :ok
    end
  end

  # Stub client that returns success for any GraphQL call
  defmodule StubClient do
    def graphql(query, _variables) do
      cond do
        String.contains?(query, "agentActivityCreate") ->
          {:ok, %{"data" => %{"agentActivityCreate" => %{"success" => true}}}}

        String.contains?(query, "agentSessionUpdate") ->
          {:ok, %{"data" => %{"agentSessionUpdate" => %{"success" => true}}}}

        true ->
          {:ok, %{"data" => %{}}}
      end
    end
  end
end
