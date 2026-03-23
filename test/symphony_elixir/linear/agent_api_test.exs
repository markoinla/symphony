defmodule SymphonyElixir.Linear.AgentAPITest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Linear.AgentAPI

  # AgentAPI makes direct HTTP calls using LINEAR_OAUTH_TOKEN.
  # These tests verify argument validation and error paths that don't
  # require a real HTTP connection.

  describe "create_session_on_issue/1" do
    test "returns error when oauth token is not set" do
      previous = System.get_env("LINEAR_OAUTH_TOKEN")
      System.delete_env("LINEAR_OAUTH_TOKEN")

      on_exit(fn ->
        if previous, do: System.put_env("LINEAR_OAUTH_TOKEN", previous)
      end)

      assert {:error, :missing_oauth_token} = AgentAPI.create_session_on_issue("issue-1")
    end
  end

  describe "create_activity/2" do
    test "returns error when oauth token is not set" do
      previous = System.get_env("LINEAR_OAUTH_TOKEN")
      System.delete_env("LINEAR_OAUTH_TOKEN")

      on_exit(fn ->
        if previous, do: System.put_env("LINEAR_OAUTH_TOKEN", previous)
      end)

      assert {:error, :missing_oauth_token} =
               AgentAPI.create_activity("session-abc", %{type: "thought", body: "test"})
    end
  end

  describe "update_session/2" do
    test "returns error when oauth token is not set" do
      previous = System.get_env("LINEAR_OAUTH_TOKEN")
      System.delete_env("LINEAR_OAUTH_TOKEN")

      on_exit(fn ->
        if previous, do: System.put_env("LINEAR_OAUTH_TOKEN", previous)
      end)

      assert {:error, :missing_oauth_token} =
               AgentAPI.update_session("session-abc", plan: [])
    end
  end
end
