defmodule SymphonyElixir.ErrorClassifierTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.ErrorClassifier

  describe "classify/1 — timeout" do
    test "turn_timeout" do
      assert ErrorClassifier.classify(:turn_timeout) == :timeout
    end

    test "response_timeout" do
      assert ErrorClassifier.classify(:response_timeout) == :timeout
    end

    test "workspace_hook_timeout" do
      assert ErrorClassifier.classify({:workspace_hook_timeout, "before_run", 30_000}) == :timeout
    end

    test "stall detection string" do
      assert ErrorClassifier.classify("stalled for 300000ms without codex activity") == :timeout
    end
  end

  describe "classify/1 — agent" do
    test "turn_failed" do
      assert ErrorClassifier.classify({:turn_failed, %{reason: "error"}}) == :agent
    end

    test "turn_cancelled" do
      assert ErrorClassifier.classify({:turn_cancelled, %{}}) == :agent
    end

    test "approval_required" do
      assert ErrorClassifier.classify({:approval_required, %{tool: "bash"}}) == :agent
    end

    test "turn_input_required" do
      assert ErrorClassifier.classify({:turn_input_required, %{prompt: "input"}}) == :agent
    end
  end

  describe "classify/1 — config" do
    test "invalid_workspace_cwd with 2-element tuple" do
      assert ErrorClassifier.classify({:invalid_workspace_cwd, :workspace_root}) == :config
    end

    test "invalid_workspace_cwd with 3-element tuple" do
      assert ErrorClassifier.classify({:invalid_workspace_cwd, :symlink_escape, "/escaped"}) ==
               :config
    end

    test "invalid_workspace_cwd with 4-element tuple" do
      assert ErrorClassifier.classify({:invalid_workspace_cwd, :outside_workspace_root, "/a", "/b"}) == :config
    end

    test "invalid_workflow_config" do
      assert ErrorClassifier.classify({:invalid_workflow_config, "bad value for codex.model"}) ==
               :config
    end

    test "unsafe_turn_sandbox_policy" do
      assert ErrorClassifier.classify({:unsafe_turn_sandbox_policy, {:invalid_workspace_root, "/bad"}}) == :config
    end

    test "workspace_equals_root" do
      assert ErrorClassifier.classify({:workspace_equals_root, "/repo", "/repo"}) == :config
    end

    test "workspace_symlink_escape" do
      assert ErrorClassifier.classify({:workspace_symlink_escape, "/escaped", "/root"}) == :config
    end

    test "workspace_outside_root" do
      assert ErrorClassifier.classify({:workspace_outside_root, "/outside", "/root"}) == :config
    end

    test "workspace_path_unreadable" do
      assert ErrorClassifier.classify({:workspace_path_unreadable, "/path", :enoent}) == :config
    end

    test "path_canonicalize_failed" do
      assert ErrorClassifier.classify({:path_canonicalize_failed, "/path", :enoent}) == :config
    end
  end

  describe "classify/1 — infra (explicit)" do
    test "port_exit" do
      assert ErrorClassifier.classify({:port_exit, 1}) == :infra
    end

    test "bash_not_found" do
      assert ErrorClassifier.classify(:bash_not_found) == :infra
    end

    test "workspace_prepare_failed (4-tuple)" do
      assert ErrorClassifier.classify({:workspace_prepare_failed, "host", 1, "error"}) == :infra
    end

    test "workspace_prepare_failed (3-tuple)" do
      assert ErrorClassifier.classify({:workspace_prepare_failed, :invalid_output, "bad"}) ==
               :infra
    end

    test "workspace_remove_failed" do
      assert ErrorClassifier.classify({:workspace_remove_failed, "host", 1, "error"}) == :infra
    end

    test "no_worker_hosts_available" do
      assert ErrorClassifier.classify(:no_worker_hosts_available) == :infra
    end

    test "workspace_hook_failed" do
      assert ErrorClassifier.classify({:workspace_hook_failed, "before_run", 1, "error"}) ==
               :infra
    end

    test "response_error" do
      assert ErrorClassifier.classify({:response_error, "something went wrong"}) == :infra
    end

    test "invalid_thread_payload" do
      assert ErrorClassifier.classify({:invalid_thread_payload, %{}}) == :infra
    end

    test "issue_state_refresh_failed" do
      assert ErrorClassifier.classify({:issue_state_refresh_failed, :timeout}) == :infra
    end
  end

  describe "classify/1 — unknown fallback" do
    test "unknown atom defaults to :infra" do
      assert ErrorClassifier.classify(:something_totally_unknown) == :infra
    end

    test "unknown tuple defaults to :infra" do
      assert ErrorClassifier.classify({:never_seen_before, "data", 42}) == :infra
    end

    test "unknown string defaults to :infra" do
      assert ErrorClassifier.classify("some random error") == :infra
    end

    test "unknown integer defaults to :infra" do
      assert ErrorClassifier.classify(999) == :infra
    end

    test "nil defaults to :infra" do
      assert ErrorClassifier.classify(nil) == :infra
    end
  end
end
