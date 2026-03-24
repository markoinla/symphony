defmodule SymphonyElixir.Store.SessionDebugTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Store

  defp create_session(overrides \\ %{}) do
    attrs =
      Map.merge(
        %{
          issue_id: "issue-#{System.unique_integer([:positive])}",
          session_id: "session-#{System.unique_integer([:positive])}",
          status: "completed",
          started_at: ~U[2026-03-24 10:00:00Z],
          ended_at: ~U[2026-03-24 10:05:00Z],
          workflow_name: "default",
          config_snapshot: %{"model" => "claude-sonnet-4-20250514"},
          stderr: "some stderr output",
          hook_results: [%{"hook" => "before_run", "exit_code" => 0}]
        },
        overrides
      )

    {:ok, session} = Store.create_session(attrs)
    session
  end

  describe "get_session_debug/1" do
    test "returns session with preloaded messages" do
      session = create_session()
      {:ok, _} = Store.append_message(session.id, %{seq: 1, type: "response", content: "hello", timestamp: ~U[2026-03-24 10:01:00Z]})

      result = Store.get_session_debug(session.id)

      assert result.id == session.id
      assert length(result.messages) == 1
      assert hd(result.messages).content == "hello"
    end

    test "returns nil for nonexistent session" do
      assert is_nil(Store.get_session_debug(999_999))
    end

    test "preloads messages ordered by seq ascending" do
      session = create_session()
      {:ok, _} = Store.append_message(session.id, %{seq: 3, type: "response", content: "third", timestamp: ~U[2026-03-24 10:03:00Z]})
      {:ok, _} = Store.append_message(session.id, %{seq: 1, type: "response", content: "first", timestamp: ~U[2026-03-24 10:01:00Z]})
      {:ok, _} = Store.append_message(session.id, %{seq: 2, type: "response", content: "second", timestamp: ~U[2026-03-24 10:02:00Z]})

      result = Store.get_session_debug(session.id)
      seqs = Enum.map(result.messages, & &1.seq)
      assert seqs == [1, 2, 3]
    end

    test "includes all session fields" do
      session = create_session()
      result = Store.get_session_debug(session.id)

      assert result.workflow_name == "default"
      assert result.config_snapshot == %{"model" => "claude-sonnet-4-20250514"}
      assert result.stderr == "some stderr output"
      assert result.hook_results == [%{"hook" => "before_run", "exit_code" => 0}]
    end

    test "returns empty messages list when session has no messages" do
      session = create_session()
      result = Store.get_session_debug(session.id)
      assert result.messages == []
    end
  end
end
