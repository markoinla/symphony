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

    # Ensure no env password interferes
    original_env = System.get_env("SYMPHONY_AUTH_PASSWORD")
    System.delete_env("SYMPHONY_AUTH_PASSWORD")

    on_exit(fn ->
      restore_env("SYMPHONY_AUTH_PASSWORD", original_env)
    end)

    :ok
  end

  defp create_test_user(attrs \\ %{}) do
    defaults = %{email: "test@example.com", password: "password123", name: "Test User"}
    SymphonyElixir.Accounts.create_user_with_password(Map.merge(defaults, attrs))
  end

  describe "POST /api/v1/auth/login" do
    test "returns 200 and user object on valid credentials" do
      {:ok, _user} = create_test_user()

      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/login", %{"email" => "test@example.com", "password" => "password123"})

      body = json_response(conn, 200)
      assert body["ok"] == true
      assert body["user"]["email"] == "test@example.com"
      assert body["user"]["name"] == "Test User"
      assert body["user"]["id"] != nil
      assert get_resp_header(conn, "set-cookie") != []
    end

    test "returns 401 with wrong password" do
      {:ok, _user} = create_test_user()

      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/login", %{"email" => "test@example.com", "password" => "wrong"})

      assert json_response(conn, 401)["error"]["code"] == "unauthorized"
    end

    test "returns 401 with non-existent email" do
      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/login", %{"email" => "nobody@example.com", "password" => "password123"})

      assert json_response(conn, 401)["error"]["code"] == "unauthorized"
    end

    test "returns 400 when email or password is missing" do
      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/login", %{"email" => "test@example.com"})

      assert json_response(conn, 400)["error"]["code"] == "bad_request"
    end

    test "returns 400 when params are empty" do
      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/login", %{})

      assert json_response(conn, 400)["error"]["code"] == "bad_request"
    end
  end

  describe "POST /api/v1/auth/setup" do
    test "creates first user, org, and membership" do
      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/setup", %{
          "email" => "admin@example.com",
          "password" => "securepass123",
          "name" => "Admin"
        })

      body = json_response(conn, 200)
      assert body["ok"] == true
      assert body["user"]["email"] == "admin@example.com"
      assert body["user"]["name"] == "Admin"
      assert get_resp_header(conn, "set-cookie") != []

      # Verify org was created
      org = SymphonyElixir.Accounts.get_default_organization()
      assert org != nil
      assert org.slug == "default"
    end

    test "returns 409 when setup already complete" do
      {:ok, _user} = create_test_user()

      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/setup", %{
          "email" => "another@example.com",
          "password" => "securepass123"
        })

      assert json_response(conn, 409)["error"]["code"] == "already_configured"
    end

    test "returns 400 when email or password is missing" do
      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/setup", %{"email" => "admin@example.com"})

      assert json_response(conn, 400)["error"]["code"] == "bad_request"
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
    test "returns authenticated: true with user object when logged in" do
      {:ok, user} = create_test_user()

      # Login first to get session
      login_conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/auth/login", %{"email" => "test@example.com", "password" => "password123"})

      assert json_response(login_conn, 200)["ok"] == true

      # Extract session cookie and use it for status check
      cookie =
        login_conn
        |> get_resp_header("set-cookie")
        |> List.first()
        |> String.split(";")
        |> List.first()

      status_conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> put_req_header("cookie", cookie)
        |> get("/api/v1/auth/status")

      body = json_response(status_conn, 200)
      assert body["authenticated"] == true
      assert body["auth_required"] == true
      assert body["user"]["id"] == user.id
      assert body["user"]["email"] == "test@example.com"
    end

    test "returns authenticated: false when user exists but not logged in" do
      {:ok, _user} = create_test_user()

      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> get("/api/v1/auth/status")

      body = json_response(conn, 200)
      assert body["authenticated"] == false
      assert body["auth_required"] == true
      refute Map.has_key?(body, "user")
    end

    test "returns authenticated: true when no users exist (auth not configured)" do
      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> get("/api/v1/auth/status")

      body = json_response(conn, 200)
      assert body["authenticated"] == true
      assert body["auth_required"] == false
    end
  end

  describe "RequireAuth plug" do
    test "returns 401 for API requests when user exists and not authenticated" do
      {:ok, _user} = create_test_user()

      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/state")

      assert json_response(conn, 401)["error"]["code"] == "unauthorized"
    end

    test "passes through when no users exist" do
      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/auth/status")

      assert json_response(conn, 200)["authenticated"] == true
    end

    test "webhooks are not affected by auth" do
      {:ok, _user} = create_test_user()

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
