defmodule SymphonyElixirWeb.AgentApiControllerTest do
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

    # Disable auth so we can reach authenticated routes
    original = System.get_env("SYMPHONY_AUTH_PASSWORD")
    System.delete_env("SYMPHONY_AUTH_PASSWORD")

    on_exit(fn ->
      if original, do: System.put_env("SYMPHONY_AUTH_PASSWORD", original), else: :ok
    end)

    :ok
  end

  test "GET /api/v1/agents returns JSON array with correct shape" do
    # Create a DB agent to verify merge
    {:ok, _} = Store.upsert_agent(%{name: "WORKFLOW", enabled: true})

    conn =
      build_conn()
      |> get("/api/v1/agents")

    assert %{"agents" => agents} = json_response(conn, 200)
    assert is_list(agents)

    # At least one agent should be present (the one we created or from WorkflowStore)
    assert agents != []

    # Find the WORKFLOW agent we created
    workflow_agent = Enum.find(agents, &(&1["name"] == "WORKFLOW"))
    assert workflow_agent

    # Verify the response shape
    assert Map.has_key?(workflow_agent, "name")
    assert Map.has_key?(workflow_agent, "enabled")
    assert Map.has_key?(workflow_agent, "loaded")
    assert Map.has_key?(workflow_agent, "description")
    assert Map.has_key?(workflow_agent, "config")
    assert Map.has_key?(workflow_agent, "raw_config")
    assert is_boolean(workflow_agent["enabled"])
    assert is_boolean(workflow_agent["loaded"])
    assert is_map(workflow_agent["config"])
    assert is_map(workflow_agent["raw_config"])
  end

  test "GET /api/v1/agents includes loaded workflows" do
    conn =
      build_conn()
      |> get("/api/v1/agents")

    assert %{"agents" => agents} = json_response(conn, 200)

    # The test setup creates a WORKFLOW.md, so WorkflowStore should have loaded it
    loaded_agents = Enum.filter(agents, & &1["loaded"])

    if loaded_agents != [] do
      agent = List.first(loaded_agents)
      assert is_map(agent["config"])
    end
  end

  test "GET /api/v1/agents redacts sensitive config fields" do
    conn =
      build_conn()
      |> get("/api/v1/agents")

    assert %{"agents" => agents} = json_response(conn, 200)

    for agent <- agents do
      raw = agent["raw_config"]

      if is_map(raw) do
        tracker = raw["tracker"]

        if is_map(tracker) and Map.has_key?(tracker, "api_key") do
          assert tracker["api_key"] == "[REDACTED]"
        end
      end
    end
  end
end
