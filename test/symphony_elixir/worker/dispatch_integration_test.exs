defmodule SymphonyElixir.Worker.DispatchIntegrationTest do
  @moduledoc """
  End-to-end coverage for the lease/backend selection at the orchestrator
  dispatch boundary. These tests exercise the seam between
  `Orchestrator.select_worker_host/2` and `Orchestrator.build_dispatch_lease/2`,
  which together produce the worker_host string + Lease that the agent runner
  consumes.
  """

  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Linear.Issue
  alias SymphonyElixir.Orchestrator
  alias SymphonyElixir.Worker.{Backend, Lease}

  setup do
    SymphonyElixir.Store.delete_all_projects()
    issue = %Issue{id: "i-1", identifier: "DISP-1", title: "t", state: "Todo", url: "u"}
    {:ok, issue: issue}
  end

  test ":auto with no ssh_hosts → Local lease (worker_host nil)", %{issue: issue} do
    write_workflow_file!(Workflow.workflow_file_path(), worker_ssh_hosts: [])

    {:ok, pid} = Orchestrator.start_link(name: __MODULE__.AutoLocal)
    on_exit(fn -> if Process.alive?(pid), do: Process.exit(pid, :normal) end)

    state = :sys.get_state(pid)

    assert Orchestrator.select_worker_host_for_test(state, nil) == nil

    lease = Orchestrator.build_dispatch_lease_for_test(issue, nil)
    assert %Lease{} = lease
    assert lease.backend == Backend.Local
    assert lease.host == "local"
    assert Lease.local?(lease)
  end

  test ":auto with ssh_hosts → SSHStatic lease tagged with selected host", %{issue: issue} do
    write_workflow_file!(Workflow.workflow_file_path(),
      worker_ssh_hosts: ["worker-1.example", "worker-2.example"]
    )

    {:ok, pid} = Orchestrator.start_link(name: __MODULE__.AutoSSH)
    on_exit(fn -> if Process.alive?(pid), do: Process.exit(pid, :normal) end)

    state = :sys.get_state(pid)
    selected = Orchestrator.select_worker_host_for_test(state, nil)
    assert selected in ["worker-1.example", "worker-2.example"]

    lease = Orchestrator.build_dispatch_lease_for_test(issue, selected)
    assert %Lease{} = lease
    assert lease.backend == Backend.SSHStatic
    assert lease.host == selected
    refute Lease.local?(lease)
  end

  test "explicit :local backend overrides ssh_hosts → forces local dispatch", %{issue: issue} do
    write_workflow_file!(Workflow.workflow_file_path(),
      worker_backend: "local",
      worker_ssh_hosts: ["worker-1.example"]
    )

    {:ok, pid} = Orchestrator.start_link(name: __MODULE__.ForcedLocal)
    on_exit(fn -> if Process.alive?(pid), do: Process.exit(pid, :normal) end)

    state = :sys.get_state(pid)
    assert Orchestrator.select_worker_host_for_test(state, nil) == nil

    lease = Orchestrator.build_dispatch_lease_for_test(issue, nil)
    assert lease.backend == Backend.Local
  end

  test "explicit :ssh_static backend with empty ssh_hosts → falls back to Local lease", %{issue: issue} do
    # Acquire on SSHStatic without a host returns {:error, :missing_ssh_host};
    # the orchestrator falls back to a Local lease so the dispatch still progresses.
    write_workflow_file!(Workflow.workflow_file_path(),
      worker_backend: "ssh_static",
      worker_ssh_hosts: []
    )

    {:ok, pid} = Orchestrator.start_link(name: __MODULE__.SSHFallback)
    on_exit(fn -> if Process.alive?(pid), do: Process.exit(pid, :normal) end)

    lease = Orchestrator.build_dispatch_lease_for_test(issue, nil)
    assert lease.backend == Backend.Local
  end

  describe "AgentRunner.candidate_leases (multi-host fallback)" do
    test "expands a preferred SSHStatic lease into preferred + remaining ssh_hosts", %{issue: issue} do
      write_workflow_file!(Workflow.workflow_file_path(),
        worker_ssh_hosts: ["worker-1.example", "worker-2.example", "worker-3.example"]
      )

      {:ok, preferred_lease} = Backend.SSHStatic.acquire(issue, host: "worker-2.example")

      candidates = AgentRunner.candidate_leases_for_test(issue, lease: preferred_lease)

      assert Enum.map(candidates, & &1.host) == [
               "worker-2.example",
               "worker-1.example",
               "worker-3.example"
             ]

      # The preferred lease object itself is reused, not rebuilt.
      assert hd(candidates) == preferred_lease
    end

    test "Local lease produces a single-element candidate list (no peer pool)", %{issue: issue} do
      write_workflow_file!(Workflow.workflow_file_path(),
        worker_ssh_hosts: ["worker-1.example"]
      )

      {:ok, local_lease} = Backend.Local.acquire(issue)

      candidates = AgentRunner.candidate_leases_for_test(issue, lease: local_lease)

      assert candidates == [local_lease]
    end
  end
end
