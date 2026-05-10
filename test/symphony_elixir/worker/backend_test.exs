defmodule SymphonyElixir.Worker.BackendTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Worker.Backend
  alias SymphonyElixir.Worker.Backend.{Local, SSHStatic}

  describe "resolve_backend/1" do
    test "returns Local for :local" do
      assert Backend.resolve_backend(:local) == Local
    end

    test "returns SSHStatic for :ssh_static" do
      assert Backend.resolve_backend(:ssh_static) == SSHStatic
    end

    test "treats nil and :auto identically" do
      assert Backend.resolve_backend(nil) == Backend.resolve_backend(:auto)
    end
  end

  describe "current/0 with :auto" do
    test "returns Local when worker.ssh_hosts is empty" do
      write_workflow_file!(Workflow.workflow_file_path(), worker_ssh_hosts: [])
      assert Backend.current() == Local
    end

    test "returns SSHStatic when worker.ssh_hosts is non-empty" do
      write_workflow_file!(Workflow.workflow_file_path(),
        worker_ssh_hosts: ["worker-1.example", "worker-2.example"]
      )

      assert Backend.current() == SSHStatic
    end
  end

  describe "current/0 with explicit backend" do
    test "respects worker.backend: local even when ssh_hosts is set" do
      write_workflow_file!(Workflow.workflow_file_path(),
        worker_backend: "local",
        worker_ssh_hosts: ["worker-1.example"]
      )

      assert Backend.current() == Local
    end

    test "respects worker.backend: ssh_static" do
      write_workflow_file!(Workflow.workflow_file_path(),
        worker_backend: "ssh_static",
        worker_ssh_hosts: ["worker-1.example"]
      )

      assert Backend.current() == SSHStatic
    end
  end
end
