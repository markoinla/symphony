defmodule SymphonyElixirWeb.ObservabilityApiControllerTest do
  use SymphonyElixir.TestSupport

  import Phoenix.ConnTest
  import Plug.Conn

  alias SymphonyElixir.Store

  @endpoint SymphonyElixirWeb.Endpoint

  setup do
    endpoint_config = Application.get_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, [])

    Application.put_env(
      :symphony_elixir,
      SymphonyElixirWeb.Endpoint,
      Keyword.merge(endpoint_config,
        secret_key_base: Base.encode64(:crypto.strong_rand_bytes(48)),
        server: false,
        http: [port: 0]
      )
    )

    start_supervised!({SymphonyElixirWeb.Endpoint, []})

    on_exit(fn ->
      Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, endpoint_config)
    end)

    # Disable auth so we can reach authenticated routes
    original = System.get_env("SYMPHONY_AUTH_PASSWORD")
    System.delete_env("SYMPHONY_AUTH_PASSWORD")

    on_exit(fn ->
      if original, do: System.put_env("SYMPHONY_AUTH_PASSWORD", original), else: :ok
    end)

    :ok
  end

  defp create_debug_session(overrides \\ %{}) do
    started_at = ~U[2026-03-24 10:00:00Z]
    ended_at = ~U[2026-03-24 10:05:30Z]

    attrs =
      Map.merge(
        %{
          issue_id: "issue-#{System.unique_integer([:positive])}",
          issue_identifier: "SYM-999",
          issue_title: "Test issue",
          session_id: "thread-1-turn-1",
          status: "completed",
          started_at: started_at,
          ended_at: ended_at,
          turn_count: 5,
          input_tokens: 1200,
          output_tokens: 800,
          total_tokens: 2000,
          worker_host: "worker-1",
          workspace_path: "/tmp/workspaces/SYM-999",
          workflow_name: "default",
          config_snapshot: %{"model" => "claude-sonnet-4-20250514", "max_turns" => 20},
          stderr: "warning: unused variable x",
          hook_results: [%{"hook" => "before_run", "exit_code" => 0, "output" => "ok"}],
          dispatch_source: "orchestrator"
        },
        overrides
      )

    {:ok, session} = Store.create_session(attrs)
    session
  end

  defp add_messages(session) do
    msgs = [
      %{seq: 1, type: "response", content: "Starting work", metadata: nil, timestamp: ~U[2026-03-24 10:01:00Z]},
      %{seq: 2, type: "tool_call", content: "read file.ex", metadata: "{\"tool\":\"read\"}", timestamp: ~U[2026-03-24 10:02:00Z]},
      %{seq: 3, type: "error", content: "compilation failed", metadata: nil, timestamp: ~U[2026-03-24 10:03:00Z]},
      %{seq: 4, type: "response", content: "Fixed the issue", metadata: nil, timestamp: ~U[2026-03-24 10:04:00Z]},
      %{seq: 5, type: "error", content: "test failure", metadata: nil, timestamp: ~U[2026-03-24 10:05:00Z]}
    ]

    for msg <- msgs do
      {:ok, _} = Store.append_message(session.id, msg)
    end

    msgs
  end

  describe "GET /api/v1/sessions/:id/debug" do
    test "returns full debug payload with correct shape" do
      session = create_debug_session()
      add_messages(session)

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/#{session.id}/debug")

      body = json_response(conn, 200)

      # Session fields
      assert body["session"]["id"] == session.id
      assert body["session"]["issue_identifier"] == "SYM-999"
      assert body["session"]["issue_title"] == "Test issue"
      assert body["session"]["session_id"] == "thread-1-turn-1"
      assert body["session"]["status"] == "completed"
      assert body["session"]["workflow_name"] == "default"
      assert body["session"]["config_snapshot"] == %{"model" => "claude-sonnet-4-20250514", "max_turns" => 20}
      assert body["session"]["stderr"] == "warning: unused variable x"
      assert body["session"]["hook_results"] == [%{"hook" => "before_run", "exit_code" => 0, "output" => "ok"}]
      assert body["session"]["worker_host"] == "worker-1"
      assert body["session"]["workspace_path"] == "/tmp/workspaces/SYM-999"
      assert body["session"]["turn_count"] == 5
      assert body["session"]["input_tokens"] == 1200
      assert body["session"]["output_tokens"] == 800
      assert body["session"]["total_tokens"] == 2000
      assert body["session"]["dispatch_source"] == "orchestrator"
      assert is_binary(body["session"]["started_at"])
      assert is_binary(body["session"]["ended_at"])

      # Messages present
      assert is_list(body["messages"])
      assert length(body["messages"]) == 5

      # Summary present
      assert is_map(body["summary"])
    end

    test "returns 404 for nonexistent session ID" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/999999/debug")

      body = json_response(conn, 404)
      assert body["error"]["code"] == "session_not_found"
      assert body["error"]["message"] == "Session not found"
    end

    test "returns 404 for invalid session ID" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/not-a-number/debug")

      body = json_response(conn, 404)
      assert body["error"]["code"] == "session_not_found"
    end

    test "computes summary fields correctly" do
      session = create_debug_session()
      add_messages(session)

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/#{session.id}/debug")

      body = json_response(conn, 200)
      summary = body["summary"]

      assert summary["message_count"] == 5
      assert summary["error_message_count"] == 2
      # 5 minutes 30 seconds = 330 seconds
      assert summary["duration_seconds"] == 330
    end

    test "returns nil duration_seconds when session has no ended_at" do
      session = create_debug_session(%{ended_at: nil, status: "running"})

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/#{session.id}/debug")

      body = json_response(conn, 200)
      assert is_nil(body["summary"]["duration_seconds"])
    end

    test "messages are ordered by seq ascending" do
      session = create_debug_session()

      # Insert messages out of order
      {:ok, _} = Store.append_message(session.id, %{seq: 3, type: "response", content: "third", metadata: nil, timestamp: ~U[2026-03-24 10:03:00Z]})
      {:ok, _} = Store.append_message(session.id, %{seq: 1, type: "response", content: "first", metadata: nil, timestamp: ~U[2026-03-24 10:01:00Z]})
      {:ok, _} = Store.append_message(session.id, %{seq: 2, type: "tool_call", content: "second", metadata: nil, timestamp: ~U[2026-03-24 10:02:00Z]})

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/#{session.id}/debug")

      body = json_response(conn, 200)
      seqs = Enum.map(body["messages"], & &1["seq"])
      assert seqs == [1, 2, 3]
    end

    test "message metadata is decoded from JSON" do
      session = create_debug_session()

      {:ok, _} =
        Store.append_message(session.id, %{
          seq: 1,
          type: "tool_call",
          content: "read file",
          metadata: "{\"tool\":\"read\",\"path\":\"lib/app.ex\"}",
          timestamp: ~U[2026-03-24 10:01:00Z]
        })

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/#{session.id}/debug")

      body = json_response(conn, 200)
      [msg] = body["messages"]
      assert msg["metadata"] == %{"tool" => "read", "path" => "lib/app.ex"}
    end

    test "returns empty messages array for session with no messages" do
      session = create_debug_session()

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/#{session.id}/debug")

      body = json_response(conn, 200)
      assert body["messages"] == []
      assert body["summary"]["message_count"] == 0
      assert body["summary"]["error_message_count"] == 0
    end
  end
end
