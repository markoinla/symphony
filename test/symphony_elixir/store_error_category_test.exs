defmodule SymphonyElixir.StoreErrorCategoryTest do
  use SymphonyElixir.DataCase, async: true

  alias SymphonyElixir.Store

  test "complete_session persists error_category for failed sessions" do
    {:ok, session} =
      Store.create_session(%{
        issue_id: "issue-errcat-1",
        issue_identifier: "SYM-182",
        session_id: "session-errcat-1",
        status: "running",
        started_at: DateTime.utc_now()
      })

    {:ok, completed} =
      Store.complete_session(session.id, %{
        status: "failed",
        error: "port crashed",
        error_category: "agent"
      })

    assert completed.error_category == "agent"
    assert completed.status == "failed"

    refetched = Store.get_session(session.id)
    assert refetched.error_category == "agent"
  end

  test "complete_session_by_engine_session_id persists error_category" do
    {:ok, _session} =
      Store.create_session(%{
        issue_id: "issue-errcat-2",
        issue_identifier: "SYM-182",
        session_id: "engine-session-errcat-2",
        status: "running",
        started_at: DateTime.utc_now()
      })

    {:ok, completed} =
      Store.complete_session_by_engine_session_id("engine-session-errcat-2", %{
        status: "failed",
        error: "turn timed out",
        error_category: "timeout"
      })

    assert completed.error_category == "timeout"
    assert completed.status == "failed"
  end

  test "completed sessions have nil error_category" do
    {:ok, session} =
      Store.create_session(%{
        issue_id: "issue-errcat-3",
        issue_identifier: "SYM-182",
        session_id: "session-errcat-3",
        status: "running",
        started_at: DateTime.utc_now()
      })

    {:ok, completed} =
      Store.complete_session(session.id, %{
        status: "completed",
        error_category: nil
      })

    assert is_nil(completed.error_category)
    assert completed.status == "completed"
  end
end
