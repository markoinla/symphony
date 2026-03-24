defmodule SymphonyElixirWeb.DebugEndpointTest do
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

    :ok
  end

  defp create_session(attrs \\ %{}) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    base = %{
      issue_id: "issue-#{System.unique_integer([:positive])}",
      session_id: "session-#{System.unique_integer([:positive])}",
      status: "completed",
      started_at: DateTime.add(now, -90, :second),
      ended_at: now,
      issue_identifier: "SYM-999",
      issue_title: "Test Issue",
      turn_count: 5,
      input_tokens: 10_000,
      output_tokens: 3_000,
      total_tokens: 13_000,
      worker_host: "local",
      workspace_path: "/tmp/test-workspace",
      dispatch_source: "orchestrator",
      workflow_name: "WORKFLOW",
      config_snapshot: %{
        "model" => "claude-sonnet-4-6",
        "engine" => "claude",
        "max_turns" => 15,
        "permission_mode" => "bypassPermissions"
      },
      stderr: "some stderr output",
      hook_results: [%{"hook_name" => "post_clone", "status" => "success", "output" => "ok"}]
    }

    {:ok, session} = Store.create_session(Map.merge(base, attrs))
    session
  end

  defp create_message(session_id, seq, attrs) do
    base = %{
      session_id: session_id,
      seq: seq,
      type: "response",
      content: "Message #{seq}",
      timestamp: DateTime.utc_now() |> DateTime.truncate(:second)
    }

    {:ok, message} = Store.append_message(session_id, Map.merge(base, attrs))
    message
  end

  describe "GET /api/v1/sessions/:id/debug" do
    test "returns full debug payload for existing session" do
      session = create_session()
      create_message(session.id, 1, %{type: "response", content: "Hello"})
      create_message(session.id, 2, %{type: "tool_call", content: "run tests"})
      create_message(session.id, 3, %{type: "error", content: "something failed"})

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/#{session.id}/debug")

      assert %{
               "session" => session_data,
               "messages" => messages,
               "summary" => summary
             } = json_response(conn, 200)

      # Session fields
      assert session_data["id"] == session.id
      assert session_data["issue_id"] == session.issue_id
      assert session_data["issue_identifier"] == "SYM-999"
      assert session_data["issue_title"] == "Test Issue"
      assert session_data["session_id"] == session.session_id
      assert session_data["workflow_name"] == "WORKFLOW"
      assert session_data["status"] == "completed"
      assert session_data["stderr"] == "some stderr output"
      assert session_data["turn_count"] == 5
      assert session_data["input_tokens"] == 10_000
      assert session_data["output_tokens"] == 3_000
      assert session_data["total_tokens"] == 13_000
      assert session_data["worker_host"] == "local"
      assert session_data["workspace_path"] == "/tmp/test-workspace"
      assert session_data["dispatch_source"] == "orchestrator"

      # Config snapshot
      assert session_data["config_snapshot"]["model"] == "claude-sonnet-4-6"
      assert session_data["config_snapshot"]["engine"] == "claude"

      # Hook results
      assert [%{"hook_name" => "post_clone", "status" => "success"}] = session_data["hook_results"]

      # Messages
      assert length(messages) == 3

      # Summary
      assert summary["message_count"] == 3
      assert summary["error_message_count"] == 1
      assert summary["duration_seconds"] == 90
    end

    test "returns 404 for nonexistent session" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/999999/debug")

      assert %{"error" => %{"code" => "session_not_found"}} = json_response(conn, 404)
    end

    test "returns 404 for invalid session ID" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/abc/debug")

      assert %{"error" => %{"code" => "session_not_found"}} = json_response(conn, 404)
    end

    test "messages are ordered by seq asc" do
      session = create_session()
      # Create messages out of order
      create_message(session.id, 3, %{content: "third"})
      create_message(session.id, 1, %{content: "first"})
      create_message(session.id, 2, %{content: "second"})

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/#{session.id}/debug")

      %{"messages" => messages} = json_response(conn, 200)

      assert [
               %{"seq" => 1, "content" => "first"},
               %{"seq" => 2, "content" => "second"},
               %{"seq" => 3, "content" => "third"}
             ] = messages
    end

    test "summary computation with no messages" do
      session = create_session()

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/#{session.id}/debug")

      %{"summary" => summary} = json_response(conn, 200)

      assert summary["message_count"] == 0
      assert summary["error_message_count"] == 0
      assert summary["duration_seconds"] == 90
    end

    test "duration_seconds is nil when ended_at is nil" do
      session = create_session(%{ended_at: nil, status: "running"})

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/#{session.id}/debug")

      %{"summary" => summary} = json_response(conn, 200)

      assert is_nil(summary["duration_seconds"])
    end

    test "handles session with nil optional fields" do
      session =
        create_session(%{
          workflow_name: nil,
          config_snapshot: nil,
          stderr: nil,
          hook_results: nil,
          error: nil
        })

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/sessions/#{session.id}/debug")

      %{"session" => session_data} = json_response(conn, 200)

      assert is_nil(session_data["workflow_name"])
      assert is_nil(session_data["config_snapshot"])
      assert is_nil(session_data["stderr"])
      assert is_nil(session_data["hook_results"])
      assert is_nil(session_data["error"])
    end
  end
end
