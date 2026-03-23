defmodule SymphonyElixirWeb.AuthControllerTest do
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

  describe "POST /api/v1/auth/login" do
    test "returns 401 with wrong password" do
      original = System.get_env("SYMPHONY_AUTH_PASSWORD")
      System.put_env("SYMPHONY_AUTH_PASSWORD", "correct-password")

      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/login", %{"password" => "wrong-password"})

      assert json_response(conn, 401)["error"]["code"] == "unauthorized"
      restore_env("SYMPHONY_AUTH_PASSWORD", original)
    end

    test "returns 200 and sets session on correct password" do
      original = System.get_env("SYMPHONY_AUTH_PASSWORD")
      System.put_env("SYMPHONY_AUTH_PASSWORD", "correct-password")

      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/login", %{"password" => "correct-password"})

      assert json_response(conn, 200)["ok"] == true
      assert get_resp_header(conn, "set-cookie") != []
      restore_env("SYMPHONY_AUTH_PASSWORD", original)
    end

    test "returns 400 when password is missing" do
      original = System.get_env("SYMPHONY_AUTH_PASSWORD")
      System.put_env("SYMPHONY_AUTH_PASSWORD", "correct-password")

      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/login", %{})

      assert json_response(conn, 400)["error"]["code"] == "bad_request"
      restore_env("SYMPHONY_AUTH_PASSWORD", original)
    end

    test "returns 500 when auth is not configured" do
      original = System.get_env("SYMPHONY_AUTH_PASSWORD")
      System.delete_env("SYMPHONY_AUTH_PASSWORD")

      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/login", %{"password" => "any"})

      assert json_response(conn, 500)["error"]["code"] == "not_configured"
      restore_env("SYMPHONY_AUTH_PASSWORD", original)
    end
  end

  describe "POST /api/v1/auth/logout" do
    test "returns 200 and clears session" do
      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/logout")

      assert json_response(conn, 200)["ok"] == true
    end
  end

  describe "GET /api/v1/auth/status" do
    test "returns authenticated: true when no password configured" do
      original = System.get_env("SYMPHONY_AUTH_PASSWORD")
      System.delete_env("SYMPHONY_AUTH_PASSWORD")

      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> get("/api/v1/auth/status")

      body = json_response(conn, 200)
      assert body["authenticated"] == true
      assert body["auth_required"] == false
      restore_env("SYMPHONY_AUTH_PASSWORD", original)
    end

    test "returns authenticated: false when password configured but not logged in" do
      original = System.get_env("SYMPHONY_AUTH_PASSWORD")
      System.put_env("SYMPHONY_AUTH_PASSWORD", "test-password")

      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> get("/api/v1/auth/status")

      body = json_response(conn, 200)
      assert body["authenticated"] == false
      assert body["auth_required"] == true
      restore_env("SYMPHONY_AUTH_PASSWORD", original)
    end
  end

  describe "RequireAuth plug" do
    test "returns 401 for API requests when auth is required and not authenticated" do
      original = System.get_env("SYMPHONY_AUTH_PASSWORD")
      System.put_env("SYMPHONY_AUTH_PASSWORD", "test-password")

      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/state")

      assert json_response(conn, 401)["error"]["code"] == "unauthorized"
      restore_env("SYMPHONY_AUTH_PASSWORD", original)
    end

    test "passes through when no password is configured" do
      original = System.get_env("SYMPHONY_AUTH_PASSWORD")
      System.delete_env("SYMPHONY_AUTH_PASSWORD")

      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/auth/status")

      assert json_response(conn, 200)["authenticated"] == true
      restore_env("SYMPHONY_AUTH_PASSWORD", original)
    end

    test "webhooks are not affected by auth" do
      original = System.get_env("SYMPHONY_AUTH_PASSWORD")
      System.put_env("SYMPHONY_AUTH_PASSWORD", "test-password")

      original_client = Application.get_env(:symphony_elixir, :linear_client_module)
      Application.put_env(:symphony_elixir, :linear_client_module, __MODULE__.StubClient)

      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/webhooks/linear", %{
          "action" => "created",
          "data" => %{"id" => "sess-1", "issueId" => "issue-1"}
        })

      assert json_response(conn, 200)["ok"] == true

      if is_nil(original_client) do
        Application.delete_env(:symphony_elixir, :linear_client_module)
      else
        Application.put_env(:symphony_elixir, :linear_client_module, original_client)
      end

      restore_env("SYMPHONY_AUTH_PASSWORD", original)
    end
  end

  defmodule StubClient do
    def graphql(_query, _variables) do
      {:ok, %{"data" => %{"createAgentActivity" => %{"success" => true}}}}
    end

    def fetch_issue_states_by_ids(_ids) do
      {:ok, []}
    end
  end
end
