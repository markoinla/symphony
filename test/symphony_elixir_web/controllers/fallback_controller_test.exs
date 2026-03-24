defmodule SymphonyElixirWeb.FallbackControllerTest do
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

    # Disable auth so we can reach authenticated routes
    original = System.get_env("SYMPHONY_AUTH_PASSWORD")
    System.delete_env("SYMPHONY_AUTH_PASSWORD")

    on_exit(fn ->
      if original, do: System.put_env("SYMPHONY_AUTH_PASSWORD", original), else: :ok
    end)

    :ok
  end

  describe "unmatched API routes" do
    test "returns structured 404 for non-existent API path" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/this/does/not/exist")

      body = json_response(conn, 404)
      assert body["error"]["code"] == "not_found"
      assert body["error"]["message"] == "Route not found"
      assert is_binary(body["error"]["request_id"])
    end

    test "returns structured 405 for wrong HTTP method" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
        |> delete("/api/v1/state")

      body = json_response(conn, 405)
      assert body["error"]["code"] == "method_not_allowed"
      assert body["error"]["message"] == "Method not allowed"
      assert is_binary(body["error"]["request_id"])
    end
  end

  describe "action_fallback call/2" do
    test "handles {:error, :not_found}" do
      request_id = Ecto.UUID.generate()

      conn =
        build_conn()
        |> Plug.Conn.assign(:request_id, request_id)
        |> Plug.Conn.put_private(:phoenix_endpoint, SymphonyElixirWeb.Endpoint)
        |> Phoenix.Controller.put_format("json")
        |> SymphonyElixirWeb.FallbackController.call({:error, :not_found})

      body = json_response(conn, 404)
      assert body["error"]["code"] == "not_found"
      assert body["error"]["request_id"] == request_id
    end

    test "handles {:error, :bad_request}" do
      request_id = Ecto.UUID.generate()

      conn =
        build_conn()
        |> Plug.Conn.assign(:request_id, request_id)
        |> Plug.Conn.put_private(:phoenix_endpoint, SymphonyElixirWeb.Endpoint)
        |> Phoenix.Controller.put_format("json")
        |> SymphonyElixirWeb.FallbackController.call({:error, :bad_request})

      body = json_response(conn, 400)
      assert body["error"]["code"] == "bad_request"
      assert body["error"]["request_id"] == request_id
    end

    test "handles {:error, changeset}" do
      changeset =
        {%{}, %{name: :string}}
        |> Ecto.Changeset.cast(%{}, [:name])
        |> Ecto.Changeset.validate_required([:name])

      conn =
        build_conn()
        |> Plug.Conn.assign(:request_id, Ecto.UUID.generate())
        |> Plug.Conn.put_private(:phoenix_endpoint, SymphonyElixirWeb.Endpoint)
        |> Phoenix.Controller.put_format("json")
        |> SymphonyElixirWeb.FallbackController.call({:error, changeset})

      body = json_response(conn, 422)
      assert body["error"]["code"] == "validation_error"
      assert body["error"]["details"]["name"] == ["can't be blank"]
    end
  end

  describe "error response includes request_id" do
    test "404 response includes x-request-id header and request_id in body" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/this/does/not/exist")

      [header_id] = get_resp_header(conn, "x-request-id")
      body = json_response(conn, 404)
      assert body["error"]["request_id"] == header_id
    end
  end
end
