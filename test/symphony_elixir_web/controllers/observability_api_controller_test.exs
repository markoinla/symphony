defmodule SymphonyElixirWeb.ObservabilityApiControllerTest do
  use SymphonyElixir.TestSupport

  import Phoenix.ConnTest
  import Plug.Conn

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

  describe "GET /healthz" do
    test "returns 200 with component statuses when healthy" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/healthz")

      body = json_response(conn, 200)
      assert body["status"] == "ok"
      assert body["components"]["app"] == "ok"
      assert body["components"]["database"] == "ok"
    end

    test "returns 503 when database is degraded" do
      # Return the sandbox connection to simulate DB unavailability
      SQLSandbox.checkin(SymphonyElixir.Repo)

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/healthz")

      body = json_response(conn, 503)
      assert body["status"] == "degraded"
      assert body["components"]["app"] == "ok"
      assert body["components"]["database"] == "degraded"
    end
  end

  describe "GET /api/v1/version" do
    test "returns app version and git SHA" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/version")

      body = json_response(conn, 200)
      assert body["version"] == "0.1.0"
      assert is_binary(body["git_sha"])
      assert body["git_sha"] != ""
    end
  end

  describe "request logging" do
    test "logs method, path, status, and duration for API requests" do
      log =
        capture_log(fn ->
          build_conn()
          |> put_req_header("accept", "application/json")
          |> get("/healthz")
        end)

      assert log =~ "method=GET"
      assert log =~ "path=/healthz"
      assert log =~ "status=200"
      assert log =~ "duration_ms="
    end

    test "logs correct status code for error responses" do
      log =
        capture_log(fn ->
          build_conn()
          |> put_req_header("accept", "application/json")
          |> get("/api/v1/version")
        end)

      assert log =~ "method=GET"
      assert log =~ "path=/api/v1/version"
      assert log =~ "status=200"
    end
  end
end
