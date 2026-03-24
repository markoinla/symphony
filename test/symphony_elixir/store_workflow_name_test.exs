defmodule SymphonyElixir.StoreWorkflowNameTest do
  use SymphonyElixir.DataCase, async: true

  alias SymphonyElixir.Store

  defp session_attrs(overrides \\ %{}) do
    Map.merge(
      %{
        issue_id: "issue-#{System.unique_integer([:positive])}",
        session_id: "session-#{System.unique_integer([:positive])}",
        status: "running",
        started_at: DateTime.utc_now()
      },
      overrides
    )
  end

  describe "create_session/1 with workflow_name" do
    test "persists workflow_name when provided" do
      attrs = session_attrs(%{workflow_name: "EPIC_SPLITTER"})
      assert {:ok, session} = Store.create_session(attrs)
      assert session.workflow_name == "EPIC_SPLITTER"
    end

    test "workflow_name is nil when not provided" do
      attrs = session_attrs()
      assert {:ok, session} = Store.create_session(attrs)
      assert session.workflow_name == nil
    end
  end

  describe "list_sessions/1 with :workflow_name filter" do
    test "returns only sessions matching workflow_name" do
      {:ok, _s1} = Store.create_session(session_attrs(%{workflow_name: "EPIC_SPLITTER"}))
      {:ok, _s2} = Store.create_session(session_attrs(%{workflow_name: "BUG_FIX"}))
      {:ok, _s3} = Store.create_session(session_attrs(%{workflow_name: "EPIC_SPLITTER"}))

      sessions = Store.list_sessions(workflow_name: "EPIC_SPLITTER")
      assert length(sessions) == 2
      assert Enum.all?(sessions, &(&1.workflow_name == "EPIC_SPLITTER"))
    end

    test "returns all sessions when workflow_name filter is nil" do
      {:ok, _s1} = Store.create_session(session_attrs(%{workflow_name: "EPIC_SPLITTER"}))
      {:ok, _s2} = Store.create_session(session_attrs(%{workflow_name: nil}))

      sessions = Store.list_sessions()
      assert length(sessions) >= 2
    end

    test "returns empty list when no sessions match workflow_name" do
      {:ok, _s1} = Store.create_session(session_attrs(%{workflow_name: "EPIC_SPLITTER"}))

      sessions = Store.list_sessions(workflow_name: "NONEXISTENT")
      assert sessions == []
    end
  end
end
