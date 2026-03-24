defmodule SymphonyElixir.StoreAgentTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Store

  test "list_agents/0 returns agents ordered by name" do
    {:ok, _} = Store.upsert_agent(%{name: "WORKFLOW_B"})
    {:ok, _} = Store.upsert_agent(%{name: "WORKFLOW_A"})

    agents = Store.list_agents()
    names = Enum.map(agents, & &1.name)
    assert names == ["WORKFLOW_A", "WORKFLOW_B"]
  end

  test "list_agents/0 returns empty list when no agents exist" do
    assert Store.list_agents() == []
  end

  test "upsert_agent/1 creates a new agent" do
    {:ok, agent} = Store.upsert_agent(%{name: "NEW_AGENT", enabled: false})

    assert agent.name == "NEW_AGENT"
    assert agent.enabled == false
    assert agent.inserted_at
    assert agent.updated_at
  end

  test "upsert_agent/1 defaults enabled to true" do
    {:ok, agent} = Store.upsert_agent(%{name: "DEFAULT_AGENT"})
    assert agent.enabled == true
  end

  test "upsert_agent/1 on conflict preserves enabled" do
    {:ok, original} = Store.upsert_agent(%{name: "CONFLICT_AGENT", enabled: false})
    assert original.enabled == false

    {:ok, _upserted} = Store.upsert_agent(%{name: "CONFLICT_AGENT"})

    # On conflict, the returned record comes from the insert attempt
    # but the DB preserves enabled — verify via re-fetch
    refetched = Store.get_agent_by_name("CONFLICT_AGENT")
    assert refetched.name == "CONFLICT_AGENT"
    # enabled should not have been overwritten by the upsert
    assert refetched.enabled == false
  end

  test "get_agent_by_name/1 returns agent when found" do
    {:ok, _} = Store.upsert_agent(%{name: "FIND_ME"})

    agent = Store.get_agent_by_name("FIND_ME")
    assert agent.name == "FIND_ME"
  end

  test "get_agent_by_name/1 returns nil when not found" do
    assert Store.get_agent_by_name("NONEXISTENT") == nil
  end
end
