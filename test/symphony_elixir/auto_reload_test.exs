defmodule SymphonyElixir.AutoReloadTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixirWeb.ObservabilityPubSub

  describe "PubSub settings notifications" do
    test "subscribe_settings and broadcast_settings_changed deliver message" do
      assert :ok = ObservabilityPubSub.subscribe_settings()
      assert :ok = ObservabilityPubSub.broadcast_settings_changed()
      assert_receive :settings_changed
    end
  end

  describe "PubSub projects notifications" do
    test "subscribe_projects and broadcast_projects_changed deliver message" do
      assert :ok = ObservabilityPubSub.subscribe_projects()
      assert :ok = ObservabilityPubSub.broadcast_projects_changed()
      assert_receive :projects_changed
    end
  end

  describe "Orchestrator handles :settings_changed" do
    test "settings_changed message refreshes config without crashing" do
      name = {:via, Registry, {SymphonyElixir.OrchestratorRegistry, "test:settings_reload"}}

      {:ok, pid} =
        Orchestrator.start_link(
          workflow_name: Workflow.default_workflow_name(),
          name: name
        )

      on_exit(fn ->
        if Process.alive?(pid), do: GenServer.stop(pid, :normal, 5_000)
      end)

      ref = Process.monitor(pid)
      send(pid, :settings_changed)
      Process.sleep(100)
      refute_receive {:DOWN, ^ref, :process, ^pid, _reason}
      Process.demonitor(ref, [:flush])
    end
  end

  describe "OrchestratorStarter handles :projects_changed" do
    test "projects_changed message triggers reconcile without crashing" do
      pid = Process.whereis(SymphonyElixir.OrchestratorStarter)

      if pid && Process.alive?(pid) do
        ref = Process.monitor(pid)
        send(pid, :projects_changed)
        Process.sleep(100)
        refute_receive {:DOWN, ^ref, :process, ^pid, _reason}
        Process.demonitor(ref, [:flush])
      end
    end
  end
end
