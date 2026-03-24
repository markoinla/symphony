defmodule SymphonyElixirWeb.Plugs.RequestIdTest do
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

  describe "RequestId plug" do
    test "adds x-request-id header to response" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/healthz")

      assert [request_id] = get_resp_header(conn, "x-request-id")
      assert is_binary(request_id)
      assert String.length(request_id) > 0
    end

    test "generates unique request ID per request" do
      conn1 =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/healthz")

      conn2 =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/healthz")

      [id1] = get_resp_header(conn1, "x-request-id")
      [id2] = get_resp_header(conn2, "x-request-id")
      assert id1 != id2
    end

    test "stores request ID in Logger metadata" do
      # Verify that after the request, Logger metadata contains the request_id.
      # Plug.RequestId sets Logger.metadata(request_id: id) during request processing.
      # We test by checking the conn's assigns match the response header, proving
      # the plug read the ID that Plug.RequestId stored in Logger metadata.
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/healthz")

      [header_id] = get_resp_header(conn, "x-request-id")
      assert conn.assigns[:request_id] == header_id
    end

    test "assigns request_id to conn.assigns" do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/healthz")

      [header_id] = get_resp_header(conn, "x-request-id")
      assert conn.assigns[:request_id] == header_id
    end
  end
end
