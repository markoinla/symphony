defmodule SymphonyElixir.Store.SessionTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Store

  describe "create_session/1 with config_snapshot" do
    test "persists config_snapshot map and round-trips it" do
      config_snapshot = %{
        "model" => "claude-sonnet-4-20250514",
        "engine" => "codex",
        "max_turns" => 20,
        "max_continuations" => 10,
        "max_concurrent_agents" => 5,
        "permission_mode" => "bypassPermissions"
      }

      attrs = %{
        issue_id: "issue-#{System.unique_integer([:positive])}",
        session_id: "session-#{System.unique_integer([:positive])}",
        status: "running",
        started_at: DateTime.utc_now(),
        config_snapshot: config_snapshot
      }

      assert {:ok, session} = Store.create_session(attrs)
      assert session.config_snapshot == config_snapshot
    end

    test "creates session without config_snapshot (nullable)" do
      attrs = %{
        issue_id: "issue-#{System.unique_integer([:positive])}",
        session_id: "session-#{System.unique_integer([:positive])}",
        status: "running",
        started_at: DateTime.utc_now()
      }

      assert {:ok, session} = Store.create_session(attrs)
      assert is_nil(session.config_snapshot)
    end

    test "config_snapshot is not overwritten by complete_session" do
      config_snapshot = %{
        "model" => "claude-sonnet-4-20250514",
        "engine" => "codex",
        "max_turns" => 20,
        "max_continuations" => 10,
        "max_concurrent_agents" => 5,
        "permission_mode" => "bypassPermissions"
      }

      attrs = %{
        issue_id: "issue-#{System.unique_integer([:positive])}",
        session_id: "session-#{System.unique_integer([:positive])}",
        status: "running",
        started_at: DateTime.utc_now(),
        config_snapshot: config_snapshot
      }

      {:ok, session} = Store.create_session(attrs)

      {:ok, completed} =
        Store.complete_session(session.id, %{status: "completed", turn_count: 5})

      assert completed.config_snapshot == config_snapshot
      assert completed.status == "completed"
    end
  end
end
