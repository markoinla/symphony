defmodule SymphonyElixirWeb.ErrorHelpersTest do
  use SymphonyElixir.TestSupport

  import Phoenix.ConnTest

  alias SymphonyElixirWeb.ErrorHelpers

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

  describe "error_response/4" do
    test "returns structured error JSON with code, message, and request_id" do
      request_id = Ecto.UUID.generate()

      conn =
        build_conn()
        |> Plug.Conn.assign(:request_id, request_id)
        |> Plug.Conn.put_private(:phoenix_endpoint, SymphonyElixirWeb.Endpoint)
        |> Phoenix.Controller.put_format("json")
        |> ErrorHelpers.error_response(404, "not_found", "Resource not found")

      body = json_response(conn, 404)
      assert body["error"]["code"] == "not_found"
      assert body["error"]["message"] == "Resource not found"
      assert body["error"]["request_id"] == request_id
    end

    test "handles nil request_id gracefully" do
      conn =
        build_conn()
        |> Plug.Conn.put_private(:phoenix_endpoint, SymphonyElixirWeb.Endpoint)
        |> Phoenix.Controller.put_format("json")
        |> ErrorHelpers.error_response(400, "bad_request", "Bad request")

      body = json_response(conn, 400)
      assert body["error"]["code"] == "bad_request"
      assert body["error"]["message"] == "Bad request"
      assert body["error"]["request_id"] == nil
    end

    test "sets the correct HTTP status code" do
      conn =
        build_conn()
        |> Plug.Conn.put_private(:phoenix_endpoint, SymphonyElixirWeb.Endpoint)
        |> Phoenix.Controller.put_format("json")
        |> ErrorHelpers.error_response(503, "service_unavailable", "Try again later")

      assert conn.status == 503
    end
  end

  describe "changeset_error_response/4" do
    test "returns structured error with details from changeset" do
      request_id = Ecto.UUID.generate()

      changeset =
        {%{}, %{name: :string}}
        |> Ecto.Changeset.cast(%{}, [:name])
        |> Ecto.Changeset.validate_required([:name])

      conn =
        build_conn()
        |> Plug.Conn.assign(:request_id, request_id)
        |> Plug.Conn.put_private(:phoenix_endpoint, SymphonyElixirWeb.Endpoint)
        |> Phoenix.Controller.put_format("json")
        |> ErrorHelpers.changeset_error_response("invalid_project", "Project is invalid", changeset)

      body = json_response(conn, 422)
      assert body["error"]["code"] == "invalid_project"
      assert body["error"]["message"] == "Project is invalid"
      assert body["error"]["request_id"] == request_id
      assert body["error"]["details"]["name"] == ["can't be blank"]
    end
  end
end
