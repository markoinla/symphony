defmodule SymphonyElixir.OrchestratorStarterTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.{Orchestrator, Store, Workflow}

  describe "ensure_orchestrators via reconciliation" do
    test "disabled agent's orchestrator is stopped on reconciliation" do
      # Get the workflow name from the test WORKFLOW.md
      [{workflow_name, _path}] = Workflow.named_workflow_paths()

      # Upsert and then disable the workflow agent
      {:ok, _} = Store.upsert_agent(%{name: workflow_name})
      {:ok, _} = Store.update_agent(workflow_name, %{enabled: false})

      # Start the OrchestratorStarter — it should NOT start the disabled workflow
      start_supervised!({SymphonyElixir.OrchestratorStarter, []})

      # Give it a moment to run ensure_orchestrators
      Process.sleep(100)

      # Verify no orchestrators are running for the disabled workflow
      running = Orchestrator.workflow_servers()
      running_keys = Enum.map(running, fn {key, _server} -> key end)
      refute workflow_name in running_keys
    end

    test "enabled agent's orchestrator is started on reconciliation" do
      [{workflow_name, _path}] = Workflow.named_workflow_paths()

      # Upsert as enabled (default)
      {:ok, _} = Store.upsert_agent(%{name: workflow_name})

      start_supervised!({SymphonyElixir.OrchestratorStarter, []})
      Process.sleep(100)

      running = Orchestrator.workflow_servers()
      running_keys = Enum.map(running, fn {key, _server} -> key end)
      assert Enum.any?(running_keys, &String.starts_with?(&1, workflow_name))
    end

    test "re-enabling agent starts orchestrator on agents_changed broadcast" do
      [{workflow_name, _path}] = Workflow.named_workflow_paths()

      # Start with disabled agent
      {:ok, _} = Store.upsert_agent(%{name: workflow_name, enabled: false})
      start_supervised!({SymphonyElixir.OrchestratorStarter, []})
      Process.sleep(100)

      # Verify it's not running
      running_before = Orchestrator.workflow_servers() |> Enum.map(fn {k, _} -> k end)
      refute Enum.any?(running_before, &String.starts_with?(&1, workflow_name))

      # Re-enable and broadcast
      {:ok, _} = Store.update_agent(workflow_name, %{enabled: true})
      SymphonyElixirWeb.ObservabilityPubSub.broadcast_agents_changed()
      Process.sleep(200)

      # Now it should be running
      running_after = Orchestrator.workflow_servers() |> Enum.map(fn {k, _} -> k end)
      assert Enum.any?(running_after, &String.starts_with?(&1, workflow_name))
    end
  end
end
