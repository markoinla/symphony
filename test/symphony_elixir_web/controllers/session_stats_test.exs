defmodule SymphonyElixirWeb.SessionStatsTest do
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

    :ok
  end

  defp create_session(overrides) do
    attrs =
      Map.merge(
        %{
          issue_id: "issue-#{System.unique_integer([:positive])}",
          session_id: "sess-#{System.unique_integer([:positive])}",
          status: "completed",
          started_at: DateTime.utc_now() |> DateTime.add(-1, :hour) |> DateTime.truncate(:second),
          organization_id: test_org_id()
        },
        overrides
      )

    {:ok, session} = Store.create_session(attrs)
    session
  end

  describe "GET /api/v1/sessions/stats" do
    test "bucketing: failure_counts has correct counts per error_category for 24h" do
      now = DateTime.utc_now() |> DateTime.truncate(:second)
      two_hours_ago = DateTime.add(now, -2, :hour)
      three_hours_ago = DateTime.add(now, -3, :hour)

      create_session(%{
        status: "failed",
        error_category: "infra",
        started_at: three_hours_ago,
        ended_at: two_hours_ago
      })

      create_session(%{
        status: "failed",
        error_category: "infra",
        started_at: three_hours_ago,
        ended_at: two_hours_ago
      })

      create_session(%{
        status: "failed",
        error_category: "agent",
        started_at: three_hours_ago,
        ended_at: two_hours_ago
      })

      create_session(%{
        status: "failed",
        error_category: "timeout",
        started_at: DateTime.add(now, -1, :hour),
        ended_at: now
      })

      conn = get(build_conn(), "/api/v1/sessions/stats?range=24h")
      assert conn.status == 200
      body = json_response(conn, 200)

      assert is_list(body["failure_counts"])
      assert body["failure_counts"] != []

      # Find the bucket that has infra=2
      infra_bucket = Enum.find(body["failure_counts"], fn b -> b["infra"] == 2 end)
      assert infra_bucket != nil
      assert infra_bucket["agent"] == 1
      assert infra_bucket["config"] == 0

      # Find the bucket with timeout
      timeout_bucket = Enum.find(body["failure_counts"], fn b -> b["timeout"] == 1 end)
      assert timeout_bucket != nil
    end

    test "dead_letters: failed session with no subsequent session appears" do
      issue_id = "dead-letter-issue-#{System.unique_integer([:positive])}"
      now = DateTime.utc_now() |> DateTime.truncate(:second)

      # This is a dead letter: failed and no subsequent session for the same issue_id
      create_session(%{
        issue_id: issue_id,
        issue_identifier: "SYM-999",
        issue_title: "Dead letter test",
        status: "failed",
        error_category: "infra",
        error: "port_exit: crash",
        started_at: DateTime.add(now, -2, :hour),
        ended_at: DateTime.add(now, -1, :hour)
      })

      conn = get(build_conn(), "/api/v1/sessions/stats?range=24h")
      body = json_response(conn, 200)

      assert is_list(body["dead_letters"])
      dead = Enum.find(body["dead_letters"], fn d -> d["issue_identifier"] == "SYM-999" end)
      assert dead != nil
      assert dead["error_category"] == "infra"
      assert dead["error"] == "port_exit: crash"
    end

    test "dead_letters: earlier failed session is NOT dead letter when later session exists" do
      issue_id = "multi-attempt-#{System.unique_integer([:positive])}"
      now = DateTime.utc_now() |> DateTime.truncate(:second)

      # First attempt: failed
      create_session(%{
        issue_id: issue_id,
        issue_identifier: "SYM-800",
        status: "failed",
        error_category: "infra",
        started_at: DateTime.add(now, -4, :hour),
        ended_at: DateTime.add(now, -3, :hour)
      })

      # Second attempt: also failed but later — this IS the dead letter
      create_session(%{
        issue_id: issue_id,
        issue_identifier: "SYM-800",
        status: "failed",
        error_category: "agent",
        started_at: DateTime.add(now, -2, :hour),
        ended_at: DateTime.add(now, -1, :hour)
      })

      conn = get(build_conn(), "/api/v1/sessions/stats?range=24h")
      body = json_response(conn, 200)

      sym800 = Enum.filter(body["dead_letters"], fn d -> d["issue_identifier"] == "SYM-800" end)
      # Only the later one should be a dead letter
      assert length(sym800) == 1
      assert hd(sym800)["error_category"] == "agent"
    end

    test "worker_health: correct totals and failure rates" do
      now = DateTime.utc_now() |> DateTime.truncate(:second)

      for _ <- 1..3 do
        create_session(%{worker_host: "worker-1.example.com", status: "completed", started_at: DateTime.add(now, -1, :hour)})
      end

      create_session(%{worker_host: "worker-1.example.com", status: "failed", started_at: DateTime.add(now, -1, :hour)})
      create_session(%{worker_host: "worker-2.example.com", status: "failed", started_at: DateTime.add(now, -1, :hour)})
      create_session(%{worker_host: "worker-2.example.com", status: "completed", started_at: DateTime.add(now, -1, :hour)})

      conn = get(build_conn(), "/api/v1/sessions/stats?range=24h")
      body = json_response(conn, 200)

      assert is_list(body["worker_health"])
      w1 = Enum.find(body["worker_health"], fn w -> w["host"] == "worker-1.example.com" end)
      assert w1["total_runs"] == 4
      assert w1["failures"] == 1
      assert w1["failure_rate"] == 0.25

      w2 = Enum.find(body["worker_health"], fn w -> w["host"] == "worker-2.example.com" end)
      assert w2["total_runs"] == 2
      assert w2["failures"] == 1
      assert w2["failure_rate"] == 0.5
    end

    test "returns 400 for invalid range" do
      conn = get(build_conn(), "/api/v1/sessions/stats?range=invalid")
      assert conn.status == 400
      body = json_response(conn, 400)
      assert body["error"]["message"] =~ "range must be one of"
    end

    test "returns 400 when range is missing" do
      conn = get(build_conn(), "/api/v1/sessions/stats")
      assert conn.status == 400
    end

    test "filter: project_id filters results to matching project" do
      now = DateTime.utc_now() |> DateTime.truncate(:second)

      {:ok, project} = Store.create_project(%{name: "test-project-stats-#{System.unique_integer([:positive])}", organization_id: test_org_id()})
      {:ok, other_project} = Store.create_project(%{name: "other-project-stats-#{System.unique_integer([:positive])}", organization_id: test_org_id()})

      create_session(%{
        project_id: project.id,
        status: "failed",
        error_category: "infra",
        worker_host: "host-a",
        started_at: DateTime.add(now, -1, :hour),
        ended_at: now
      })

      create_session(%{
        project_id: other_project.id,
        status: "failed",
        error_category: "agent",
        worker_host: "host-b",
        started_at: DateTime.add(now, -1, :hour),
        ended_at: now
      })

      conn = get(build_conn(), "/api/v1/sessions/stats?range=24h&project_id=#{project.id}")
      body = json_response(conn, 200)

      # Only project_id's sessions should appear
      total_failures =
        body["failure_counts"]
        |> Enum.reduce(0, fn b, acc -> acc + b["infra"] + b["agent"] + b["config"] + b["timeout"] end)

      assert total_failures == 1

      # worker_health should only include host-a
      hosts = Enum.map(body["worker_health"], & &1["host"])
      assert "host-a" in hosts
      refute "host-b" in hosts
    end

    test "returns empty lists when no sessions exist" do
      conn = get(build_conn(), "/api/v1/sessions/stats?range=24h")
      assert conn.status == 200
      body = json_response(conn, 200)

      assert body["failure_counts"] == []
      assert body["dead_letters"] == []
      assert body["worker_health"] == []
    end

    test "accepts all valid range values" do
      for range <- ["24h", "7d", "30d"] do
        conn = get(build_conn(), "/api/v1/sessions/stats?range=#{range}")
        assert conn.status == 200
      end
    end
  end
end
