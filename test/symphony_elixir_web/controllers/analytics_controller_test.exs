defmodule SymphonyElixirWeb.AnalyticsControllerTest do
  use SymphonyElixir.TestSupport

  import Phoenix.ConnTest

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

    # Clear pre-existing sessions so analytics tests start from a clean slate.
    # This runs inside the sandbox transaction and is rolled back after the test.
    SymphonyElixir.Repo.delete_all(SymphonyElixir.Store.Session)

    # Disable auth so we can reach authenticated routes
    original = System.get_env("SYMPHONY_AUTH_PASSWORD")
    System.delete_env("SYMPHONY_AUTH_PASSWORD")

    on_exit(fn ->
      if original, do: System.put_env("SYMPHONY_AUTH_PASSWORD", original), else: :ok
    end)

    :ok
  end

  defp create_session(overrides) do
    attrs =
      Map.merge(
        %{
          issue_id: "issue-#{System.unique_integer([:positive])}",
          session_id: "sess-#{System.unique_integer([:positive])}",
          status: "completed",
          started_at: ~U[2026-03-20 10:00:00Z],
          organization_id: test_org_id()
        },
        overrides
      )

    {:ok, session} = Store.create_session(attrs)
    session
  end

  describe "GET /api/v1/analytics/cost" do
    test "returns valid JSON matching PRD schema with seeded data" do
      create_session(%{
        workflow: "DEPLOY",
        estimated_cost_cents: 100,
        input_tokens: 500,
        output_tokens: 200,
        started_at: ~U[2026-03-20 10:00:00Z]
      })

      create_session(%{
        workflow: "DEPLOY",
        estimated_cost_cents: 200,
        input_tokens: 1000,
        output_tokens: 400,
        started_at: ~U[2026-03-20 14:00:00Z]
      })

      create_session(%{
        workflow: "REVIEW",
        estimated_cost_cents: 50,
        input_tokens: 300,
        output_tokens: 100,
        started_at: ~U[2026-03-21 09:00:00Z]
      })

      conn = get(build_conn(), "/api/v1/analytics/cost?range=30d")
      assert conn.status == 200
      body = json_response(conn, 200)

      # Top-level shape
      assert body["range"] == "30d"
      assert is_map(body["summary"])
      assert is_list(body["daily"])
      assert is_list(body["by_workflow"])

      # Summary totals
      summary = body["summary"]
      assert summary["total_cost_cents"] == 350
      assert summary["total_sessions"] == 3
      assert summary["total_input_tokens"] == 1800
      assert summary["total_output_tokens"] == 700

      # Daily entries sorted ascending by date
      dates = Enum.map(body["daily"], & &1["date"])
      assert dates == Enum.sort(dates)

      # By-workflow entries
      by_workflow = body["by_workflow"]
      deploy = Enum.find(by_workflow, &(&1["workflow"] == "DEPLOY"))
      assert deploy["cost_cents"] == 300
      assert deploy["sessions"] == 2
      assert deploy["input_tokens"] == 1500
      assert deploy["output_tokens"] == 600
      assert deploy["avg_cost_cents_per_session"] == 150

      review = Enum.find(by_workflow, &(&1["workflow"] == "REVIEW"))
      assert review["cost_cents"] == 50
      assert review["sessions"] == 1
      assert review["avg_cost_cents_per_session"] == 50
    end

    test "returns empty results when no sessions exist" do
      conn = get(build_conn(), "/api/v1/analytics/cost?range=7d")
      assert conn.status == 200
      body = json_response(conn, 200)

      assert body["range"] == "7d"
      assert body["summary"]["total_cost_cents"] == 0
      assert body["summary"]["total_sessions"] == 0
      assert body["daily"] == []
      assert body["by_workflow"] == []
    end

    test "accepts all valid range values" do
      for range <- ["7d", "30d", "90d"] do
        conn = get(build_conn(), "/api/v1/analytics/cost?range=#{range}")
        assert conn.status == 200
        body = json_response(conn, 200)
        assert body["range"] == range
      end
    end

    test "returns 400 for invalid range" do
      conn = get(build_conn(), "/api/v1/analytics/cost?range=1d")
      assert conn.status == 400
      body = json_response(conn, 400)
      assert body["error"] =~ "range must be one of"
    end

    test "returns 400 when range is missing" do
      conn = get(build_conn(), "/api/v1/analytics/cost")
      assert conn.status == 400
      body = json_response(conn, 400)
      assert body["error"] =~ "range must be one of"
    end

    test "sessions without workflow are excluded from daily and by_workflow" do
      create_session(%{
        workflow: nil,
        estimated_cost_cents: 100,
        input_tokens: 500,
        output_tokens: 200,
        started_at: ~U[2026-03-20 10:00:00Z]
      })

      create_session(%{
        workflow: "DEPLOY",
        estimated_cost_cents: 50,
        input_tokens: 300,
        output_tokens: 100,
        started_at: ~U[2026-03-20 10:00:00Z]
      })

      conn = get(build_conn(), "/api/v1/analytics/cost?range=30d")
      body = json_response(conn, 200)

      # Summary includes sessions with estimated_cost_cents (both have it)
      assert body["summary"]["total_sessions"] == 2
      assert body["summary"]["total_cost_cents"] == 150

      # Daily/by_workflow only include sessions with workflow set
      assert length(body["daily"]) == 1
      assert length(body["by_workflow"]) == 1
      assert hd(body["by_workflow"])["workflow"] == "DEPLOY"
    end

    test "running sessions are excluded from all queries" do
      create_session(%{
        status: "running",
        workflow: "DEPLOY",
        estimated_cost_cents: nil,
        input_tokens: 0,
        output_tokens: 0,
        started_at: ~U[2026-03-20 10:00:00Z]
      })

      create_session(%{
        status: "completed",
        workflow: "DEPLOY",
        estimated_cost_cents: 100,
        input_tokens: 500,
        output_tokens: 200,
        started_at: ~U[2026-03-20 10:00:00Z]
      })

      conn = get(build_conn(), "/api/v1/analytics/cost?range=30d")
      body = json_response(conn, 200)

      # Summary counts only the completed session
      assert body["summary"]["total_sessions"] == 1
      assert body["summary"]["total_cost_cents"] == 100

      # Daily/by_workflow also exclude the running session
      assert length(body["by_workflow"]) == 1
      assert hd(body["by_workflow"])["sessions"] == 1
    end

    test "completed sessions without cost are included in summary" do
      create_session(%{
        status: "completed",
        workflow: "DEPLOY",
        estimated_cost_cents: nil,
        input_tokens: 500,
        output_tokens: 200,
        started_at: ~U[2026-03-20 10:00:00Z]
      })

      conn = get(build_conn(), "/api/v1/analytics/cost?range=30d")
      body = json_response(conn, 200)

      assert body["summary"]["total_sessions"] == 1
      assert body["summary"]["total_input_tokens"] == 500
      assert body["summary"]["total_output_tokens"] == 200
    end

    test "daily entries contain expected fields" do
      create_session(%{
        workflow: "DEPLOY",
        estimated_cost_cents: 100,
        input_tokens: 500,
        output_tokens: 200,
        started_at: ~U[2026-03-20 10:00:00Z]
      })

      conn = get(build_conn(), "/api/v1/analytics/cost?range=30d")
      body = json_response(conn, 200)
      [entry] = body["daily"]

      assert Map.has_key?(entry, "date")
      assert Map.has_key?(entry, "workflow")
      assert Map.has_key?(entry, "cost_cents")
      assert Map.has_key?(entry, "sessions")
      assert Map.has_key?(entry, "input_tokens")
      assert Map.has_key?(entry, "output_tokens")

      assert entry["date"] == "2026-03-20"
      assert entry["workflow"] == "DEPLOY"
    end
  end
end
