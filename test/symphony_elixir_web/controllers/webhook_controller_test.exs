defmodule SymphonyElixirWeb.WebhookControllerTest do
  use SymphonyElixir.TestSupport

  import Phoenix.ConnTest
  import Plug.Conn

  @endpoint SymphonyElixirWeb.Endpoint

  setup do
    original = Application.get_env(:symphony_elixir, :linear_client_module)
    Application.put_env(:symphony_elixir, :linear_client_module, __MODULE__.StubClient)

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
      if is_nil(original) do
        Application.delete_env(:symphony_elixir, :linear_client_module)
      else
        Application.put_env(:symphony_elixir, :linear_client_module, original)
      end

      Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, endpoint_config)
    end)

    :ok
  end

  describe "POST /api/v1/webhooks/linear" do
    test "responds 200 for created action" do
      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/webhooks/linear", %{
          "action" => "created",
          "data" => %{
            "id" => "agent-sess-1",
            "issueId" => "issue-1"
          }
        })

      assert json_response(conn, 200) == %{"ok" => true}
    end

    test "responds 200 for prompted action" do
      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/webhooks/linear", %{
          "action" => "prompted",
          "data" => %{
            "id" => "agent-sess-1",
            "agentActivity" => %{"body" => "Please also fix the tests"}
          }
        })

      assert json_response(conn, 200) == %{"ok" => true}
    end

    test "responds 200 for unknown action" do
      conn =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/v1/webhooks/linear", %{
          "action" => "unknown_action"
        })

      assert json_response(conn, 200) == %{"ok" => true}
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
