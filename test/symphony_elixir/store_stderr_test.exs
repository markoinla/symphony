defmodule SymphonyElixir.StoreStderrTest do
  use SymphonyElixir.DataCase, async: true

  alias SymphonyElixir.Store

  test "complete_session persists stderr when provided" do
    {:ok, session} =
      Store.create_session(%{
        issue_id: "issue-stderr-1",
        issue_identifier: "SYM-168",
        session_id: "session-stderr-1",
        status: "running",
        started_at: DateTime.utc_now()
      })

    stderr_content = "Warning: something went wrong\nError: details here\n"

    {:ok, completed} =
      Store.complete_session(session.id, %{
        status: "completed",
        stderr: stderr_content
      })

    assert completed.stderr == stderr_content
    assert completed.status == "completed"

    # Verify it persisted by re-fetching
    refetched = Store.get_session(session.id)
    assert refetched.stderr == stderr_content
  end

  test "complete_session_by_engine_session_id persists stderr" do
    {:ok, _session} =
      Store.create_session(%{
        issue_id: "issue-stderr-2",
        issue_identifier: "SYM-168",
        session_id: "engine-session-stderr-2",
        status: "running",
        started_at: DateTime.utc_now()
      })

    stderr_content = "some stderr output"

    {:ok, completed} =
      Store.complete_session_by_engine_session_id("engine-session-stderr-2", %{
        status: "failed",
        error: "port crashed",
        stderr: stderr_content
      })

    assert completed.stderr == stderr_content
    assert completed.status == "failed"
  end

  test "complete_session without stderr does not overwrite existing stderr" do
    {:ok, session} =
      Store.create_session(%{
        issue_id: "issue-stderr-3",
        issue_identifier: "SYM-168",
        session_id: "session-stderr-3",
        status: "running",
        started_at: DateTime.utc_now()
      })

    # First update with stderr
    {:ok, _} =
      Store.complete_session(session.id, %{
        status: "running",
        stderr: "original stderr"
      })

    # Second update without stderr field
    {:ok, updated} =
      Store.complete_session(session.id, %{
        status: "completed"
      })

    # stderr should be preserved
    assert updated.stderr == "original stderr"
    assert updated.status == "completed"
  end

  test "complete_session with nil stderr" do
    {:ok, session} =
      Store.create_session(%{
        issue_id: "issue-stderr-4",
        issue_identifier: "SYM-168",
        session_id: "session-stderr-4",
        status: "running",
        started_at: DateTime.utc_now()
      })

    {:ok, completed} =
      Store.complete_session(session.id, %{
        status: "completed",
        stderr: nil
      })

    assert is_nil(completed.stderr)
  end

  test "complete_session_by_engine_session_id falls back to issue_identifier lookup" do
    # Simulate the race condition: create a session whose session_id has NOT
    # been updated to the engine session_id yet (still has the initial value).
    {:ok, session} =
      Store.create_session(%{
        issue_id: "issue-fallback-1",
        issue_identifier: "SYM-FALLBACK",
        session_id: "initial-placeholder",
        status: "running",
        started_at: DateTime.utc_now()
      })

    # Try to complete using an engine session_id that doesn't match any session.
    # The fallback should find the session via issue_identifier from attrs.
    {:ok, completed} =
      Store.complete_session_by_engine_session_id("unsynced-engine-id", %{
        status: "completed",
        issue_identifier: "SYM-FALLBACK",
        stderr: "fallback stderr"
      })

    assert completed.id == session.id
    assert completed.status == "completed"
    assert completed.stderr == "fallback stderr"
  end
end
