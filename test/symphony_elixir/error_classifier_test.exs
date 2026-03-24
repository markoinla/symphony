defmodule SymphonyElixir.ErrorClassifierTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.ErrorClassifier

  describe "classify/1 — timeout patterns" do
    test "classifies :turn_timeout as :timeout" do
      assert ErrorClassifier.classify(:turn_timeout) == :timeout
    end

    test "classifies :response_timeout as :timeout" do
      assert ErrorClassifier.classify(:response_timeout) == :timeout
    end

    test "classifies {:response_timeout} tuple as :timeout" do
      assert ErrorClassifier.classify({:response_timeout}) == :timeout
    end

    test "classifies {:workspace_hook_timeout, _, _} as :timeout" do
      assert ErrorClassifier.classify({:workspace_hook_timeout, "before_session", 30_000}) == :timeout
    end

    test "classifies stall detection strings as :timeout" do
      assert ErrorClassifier.classify("stalled for 120000ms without codex activity") == :timeout
    end
  end

  describe "classify/1 — agent patterns" do
    test "classifies {:turn_failed, _} as :agent" do
      assert ErrorClassifier.classify({:turn_failed, %{reason: "something"}}) == :agent
    end

    test "classifies {:turn_cancelled, _} as :agent" do
      assert ErrorClassifier.classify({:turn_cancelled, %{}}) == :agent
    end

    test "classifies {:approval_required, _} as :agent" do
      assert ErrorClassifier.classify({:approval_required, %{tool: "bash"}}) == :agent
    end

    test "classifies {:turn_input_required, _} as :agent" do
      assert ErrorClassifier.classify({:turn_input_required, %{prompt: "confirm?"}}) == :agent
    end
  end

  describe "classify/1 — config patterns" do
    test "classifies {:invalid_workspace_cwd, :symlink_escape, _, _} as :config" do
      assert ErrorClassifier.classify({:invalid_workspace_cwd, :symlink_escape, "/a", "/b"}) == :config
    end

    test "classifies {:invalid_workspace_cwd, :outside_workspace_root, _, _} as :config" do
      assert ErrorClassifier.classify({:invalid_workspace_cwd, :outside_workspace_root, "/a", "/b"}) == :config
    end

    test "classifies {:invalid_workspace_cwd, :workspace_root, _} as :config" do
      assert ErrorClassifier.classify({:invalid_workspace_cwd, :workspace_root, "/workspace"}) == :config
    end

    test "classifies {:invalid_workspace_cwd, :path_unreadable, _, _} as :config" do
      assert ErrorClassifier.classify({:invalid_workspace_cwd, :path_unreadable, "/path", :enoent}) == :config
    end

    test "classifies {:invalid_workspace_cwd, :empty_remote_workspace, _} as :config" do
      assert ErrorClassifier.classify({:invalid_workspace_cwd, :empty_remote_workspace, "worker-1"}) == :config
    end

    test "classifies {:invalid_workspace_cwd, :invalid_remote_workspace, _, _} as :config" do
      assert ErrorClassifier.classify({:invalid_workspace_cwd, :invalid_remote_workspace, "worker-1", "/bad"}) == :config
    end

    test "classifies {:invalid_workflow_config, _} as :config" do
      assert ErrorClassifier.classify({:invalid_workflow_config, "missing required field"}) == :config
    end

    test "classifies {:missing_workflow_file, _, _} as :config" do
      assert ErrorClassifier.classify({:missing_workflow_file, "/path/WORKFLOW.md", :enoent}) == :config
    end
  end

  describe "classify/1 — infra patterns" do
    test "classifies {:port_exit, _} as :infra" do
      assert ErrorClassifier.classify({:port_exit, 1}) == :infra
    end

    test "classifies :no_worker_hosts_available as :infra" do
      assert ErrorClassifier.classify(:no_worker_hosts_available) == :infra
    end

    test "classifies {:workspace_prepare_failed, _, _, _} as :infra" do
      assert ErrorClassifier.classify({:workspace_prepare_failed, "host", 1, "error"}) == :infra
    end

    test "classifies {:workspace_remove_failed, _, _, _} as :infra" do
      assert ErrorClassifier.classify({:workspace_remove_failed, "host", 1, "error"}) == :infra
    end

    test "classifies {:workspace_hook_failed, _, _, _} as :infra" do
      assert ErrorClassifier.classify({:workspace_hook_failed, "before_session", 1, "output"}) == :infra
    end

    test "classifies :bash_not_found as :infra" do
      assert ErrorClassifier.classify(:bash_not_found) == :infra
    end

    test "classifies {:response_error, _} as :infra" do
      assert ErrorClassifier.classify({:response_error, %{message: "server error"}}) == :infra
    end
  end

  describe "classify/1 — catch-all" do
    test "unknown atom defaults to :infra" do
      assert ErrorClassifier.classify(:something_unexpected) == :infra
    end

    test "unknown string defaults to :infra" do
      assert ErrorClassifier.classify("some random error") == :infra
    end

    test "unknown nested tuple defaults to :infra" do
      assert ErrorClassifier.classify({:unknown, {:nested, "thing"}}) == :infra
    end

    test "nil defaults to :infra" do
      assert ErrorClassifier.classify(nil) == :infra
    end

    test "integer defaults to :infra" do
      assert ErrorClassifier.classify(42) == :infra
    end

    test "list defaults to :infra" do
      assert ErrorClassifier.classify([:a, :b]) == :infra
    end
  end
end
