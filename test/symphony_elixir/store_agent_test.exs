defmodule SymphonyElixir.StoreAgentTest do
  use SymphonyElixir.DataCase, async: true

  import Ecto.Query
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

  test "update_agent/2 updates enabled field" do
    {:ok, _} = Store.upsert_agent(%{name: "TOGGLE_AGENT", enabled: true})

    {:ok, updated} = Store.update_agent("TOGGLE_AGENT", %{enabled: false})
    assert updated.name == "TOGGLE_AGENT"
    assert updated.enabled == false
    assert updated.updated_at
  end

  test "update_agent/2 returns not_found for missing agent" do
    assert {:error, :not_found} = Store.update_agent("MISSING", %{enabled: false})
  end

  test "update_agent/2 sets updated_at timestamp" do
    {:ok, original} = Store.upsert_agent(%{name: "TIMESTAMP_AGENT"})
    past = DateTime.add(original.updated_at, -2, :second)

    SymphonyElixir.Repo.update_all(
      from(a in "agents", where: a.name == "TIMESTAMP_AGENT"),
      set: [updated_at: past]
    )

    {:ok, updated} = Store.update_agent("TIMESTAMP_AGENT", %{enabled: false})
    assert DateTime.compare(updated.updated_at, past) == :gt
  end
end
