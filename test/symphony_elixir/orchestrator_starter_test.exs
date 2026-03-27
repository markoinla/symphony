defmodule SymphonyElixir.OrchestratorStarterTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.{Orchestrator, Store, Workflow}

  describe "ensure_orchestrators via reconciliation" do
    setup do
      # Stop all orchestrators left over from previous tests
      for {_key, server} <- Orchestrator.workflow_servers() do
        case GenServer.whereis(server) do
          pid when is_pid(pid) ->
            DynamicSupervisor.terminate_child(SymphonyElixir.OrchestratorSupervisor, pid)

          nil ->
            :ok
        end
      end

      :ok
    end

    test "disabled agent's orchestrator is stopped on reconciliation" do
      # Get the workflow name from the test WORKFLOW.md
      [{workflow_name, _path}] = Workflow.named_workflow_paths()

      # Upsert and then disable the workflow agent
      {:ok, _} = Store.upsert_agent(%{name: workflow_name})
      {:ok, _} = Store.update_agent(workflow_name, %{enabled: false})

      # Start the OrchestratorStarter — init sends :ensure_orchestrators asynchronously
      pid = start_supervised!({SymphonyElixir.OrchestratorStarter, []})
      :sys.get_state(pid)

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
      Process.sleep(50)

      running = Orchestrator.workflow_servers()
      running_keys = Enum.map(running, fn {key, _server} -> key end)
      assert Enum.any?(running_keys, &String.starts_with?(&1, workflow_name))
    end

    test "re-enabling agent starts orchestrator on agents_changed broadcast" do
      [{workflow_name, _path}] = Workflow.named_workflow_paths()

      # Start with disabled agent
      {:ok, _} = Store.upsert_agent(%{name: workflow_name, enabled: false})
      pid = start_supervised!({SymphonyElixir.OrchestratorStarter, []})

      # Verify it's not running
      running_before = Orchestrator.workflow_servers() |> Enum.map(fn {k, _} -> k end)
      refute Enum.any?(running_before, &String.starts_with?(&1, workflow_name))

      # Re-enable and broadcast
      {:ok, _} = Store.update_agent(workflow_name, %{enabled: true})
      SymphonyElixirWeb.ObservabilityPubSub.broadcast_agents_changed()
      # Force the GenServer to process the broadcast message
      :sys.get_state(pid)

      # Now it should be running
      running_after = Orchestrator.workflow_servers() |> Enum.map(fn {k, _} -> k end)
      assert Enum.any?(running_after, &String.starts_with?(&1, workflow_name))
    end

    test "label-based workflow spawns per-project orchestrators when projects exist" do
      [{_workflow_name, path}] = Workflow.named_workflow_paths()
      workflow_root = Path.dirname(path)

      # Create a second workflow file with filter_by: label
      label_workflow_path = Path.join(workflow_root, "EPIC_SPLITTER.md")

      File.write!(label_workflow_path, """
      ---
      tracker:
        kind: "linear"
        endpoint: "https://api.linear.app/graphql"
        api_key: "token"
        filter_by: "label"
        label_name: "epic-split"
        active_states: ["Todo", "In Progress"]
        terminal_states: ["Done", "Canceled"]
      polling:
        interval_ms: 30000
      workspace:
        root: "#{Path.join(System.tmp_dir!(), "symphony_workspaces")}"
      agent:
        max_concurrent_agents: 10
        max_turns: 20
      codex:
        command: "codex app-server"
      ---
      You are an epic splitter agent.
      """)

      # Register both workflows
      Workflow.set_workflow_file_paths([path, label_workflow_path])
      if Process.whereis(SymphonyElixir.WorkflowStore), do: SymphonyElixir.WorkflowStore.force_reload()

      # Create two projects
      {:ok, project1} = Store.create_project(%{name: "Project A", linear_project_slug: "proj-a", organization_id: test_org_id()})
      {:ok, project2} = Store.create_project(%{name: "Project B", linear_project_slug: "proj-b", organization_id: test_org_id()})

      pid = start_supervised!({SymphonyElixir.OrchestratorStarter, []})
      :sys.get_state(pid)

      running_keys = Orchestrator.workflow_servers() |> Enum.map(fn {k, _} -> k end)

      # The label-based workflow should have per-project orchestrators
      assert "EPIC_SPLITTER:#{project1.id}" in running_keys
      assert "EPIC_SPLITTER:#{project2.id}" in running_keys
      # Should NOT have a global "EPIC_SPLITTER" orchestrator (since projects exist)
      refute "EPIC_SPLITTER" in running_keys
    end

    test "label-based workflow gets per-project orchestrators matching project-based workflow behavior" do
      [{_workflow_name, path}] = Workflow.named_workflow_paths()
      workflow_root = Path.dirname(path)

      # Create a label-based workflow file
      label_workflow_path = Path.join(workflow_root, "ENRICHMENT.md")

      File.write!(label_workflow_path, """
      ---
      tracker:
        kind: "linear"
        endpoint: "https://api.linear.app/graphql"
        api_key: "token"
        filter_by: "label"
        label_name: "enrich"
        active_states: ["Todo", "In Progress"]
        terminal_states: ["Done", "Canceled"]
      polling:
        interval_ms: 30000
      workspace:
        root: "#{Path.join(System.tmp_dir!(), "symphony_workspaces")}"
      agent:
        max_concurrent_agents: 10
        max_turns: 20
      codex:
        command: "codex app-server"
      ---
      You are an enrichment agent.
      """)

      # Register both workflows
      Workflow.set_workflow_file_paths([path, label_workflow_path])
      if Process.whereis(SymphonyElixir.WorkflowStore), do: SymphonyElixir.WorkflowStore.force_reload()

      # Ensure at least one project exists
      {:ok, project} = Store.create_project(%{name: "Test Project", linear_project_slug: "test-proj", organization_id: test_org_id()})

      pid = start_supervised!({SymphonyElixir.OrchestratorStarter, []})
      :sys.get_state(pid)

      running_keys = Orchestrator.workflow_servers() |> Enum.map(fn {k, _} -> k end)

      # The label-based workflow should have a per-project orchestrator
      assert "ENRICHMENT:#{project.id}" in running_keys
      # Should NOT have a global "ENRICHMENT" orchestrator
      refute "ENRICHMENT" in running_keys
    end
  end
end
