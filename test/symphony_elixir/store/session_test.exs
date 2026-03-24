defmodule SymphonyElixir.Store.SessionTest do
  use SymphonyElixir.DataCase, async: true

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

  describe "create_session/1 with workflow" do
    test "persists workflow field" do
      attrs = %{
        issue_id: "issue-#{System.unique_integer([:positive])}",
        session_id: "session-#{System.unique_integer([:positive])}",
        status: "running",
        started_at: DateTime.utc_now(),
        workflow: "WORKFLOW"
      }

      assert {:ok, session} = Store.create_session(attrs)
      assert session.workflow == "WORKFLOW"
    end

    test "workflow is nullable" do
      attrs = %{
        issue_id: "issue-#{System.unique_integer([:positive])}",
        session_id: "session-#{System.unique_integer([:positive])}",
        status: "running",
        started_at: DateTime.utc_now()
      }

      assert {:ok, session} = Store.create_session(attrs)
      assert is_nil(session.workflow)
    end
  end

  describe "complete_session/2 with estimated_cost_cents" do
    test "persists estimated_cost_cents at finalization" do
      {:ok, session} =
        Store.create_session(%{
          issue_id: "issue-#{System.unique_integer([:positive])}",
          session_id: "session-#{System.unique_integer([:positive])}",
          status: "running",
          started_at: DateTime.utc_now(),
          workflow: "WORKFLOW"
        })

      {:ok, completed} =
        Store.complete_session(session.id, %{
          status: "completed",
          input_tokens: 500_000,
          output_tokens: 200_000,
          estimated_cost_cents: 450
        })

      assert completed.estimated_cost_cents == 450
      assert completed.status == "completed"
      assert completed.workflow == "WORKFLOW"
    end

    test "estimated_cost_cents is nullable" do
      {:ok, session} =
        Store.create_session(%{
          issue_id: "issue-#{System.unique_integer([:positive])}",
          session_id: "session-#{System.unique_integer([:positive])}",
          status: "running",
          started_at: DateTime.utc_now()
        })

      {:ok, completed} =
        Store.complete_session(session.id, %{status: "completed"})

      assert is_nil(completed.estimated_cost_cents)
    end
  end
end
