defmodule SymphonyElixir.HookResultsTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Store

  describe "Store.complete_session/2 with hook_results" do
    test "persists hook_results when provided in completion attrs" do
      {:ok, session} =
        Store.create_session(%{
          issue_id: "hook-test-issue-#{System.unique_integer([:positive])}",
          session_id: "hook-test-session-#{System.unique_integer([:positive])}",
          status: "running",
          started_at: DateTime.utc_now(),
          organization_id: test_org_id()
        })

      hook_results = [
        %{"hook_name" => "before_run", "status" => "ok", "output" => "setup complete"},
        %{"hook_name" => "after_run", "status" => "ok", "output" => "cleanup done"}
      ]

      {:ok, updated} =
        Store.complete_session(session.id, %{
          status: "completed",
          hook_results: hook_results
        })

      assert updated.hook_results == hook_results
      assert updated.status == "completed"
      assert updated.ended_at != nil
    end

    test "persists nil hook_results when not provided" do
      {:ok, session} =
        Store.create_session(%{
          issue_id: "hook-test-issue-#{System.unique_integer([:positive])}",
          session_id: "hook-test-session-#{System.unique_integer([:positive])}",
          status: "running",
          started_at: DateTime.utc_now(),
          organization_id: test_org_id()
        })

      {:ok, updated} =
        Store.complete_session(session.id, %{
          status: "completed"
        })

      assert updated.hook_results == nil
      assert updated.status == "completed"
    end

    test "persists hook_results with failed hook status" do
      {:ok, session} =
        Store.create_session(%{
          issue_id: "hook-test-issue-#{System.unique_integer([:positive])}",
          session_id: "hook-test-session-#{System.unique_integer([:positive])}",
          status: "running",
          started_at: DateTime.utc_now(),
          organization_id: test_org_id()
        })

      hook_results = [
        %{"hook_name" => "before_run", "status" => "failed", "output" => "exit code 1: permission denied"}
      ]

      {:ok, updated} =
        Store.complete_session(session.id, %{
          status: "failed",
          error: "hook failed",
          hook_results: hook_results
        })

      assert updated.hook_results == hook_results
      assert updated.status == "failed"
      assert updated.error == "hook failed"
    end
  end

  describe "Workspace structured hook results" do
    test "run_before_run_hook returns {:ok, []} when no hook configured" do
      assert {:ok, []} = Workspace.run_before_run_hook("/tmp/no-hook-workspace", "TEST-1")
    end

    test "run_after_run_hook returns [] when no hook configured" do
      assert [] = Workspace.run_after_run_hook("/tmp/no-hook-workspace", "TEST-1")
    end

    test "run_before_run_hook returns structured results on success" do
      workspace = Path.join(System.tmp_dir!(), "hook-test-#{System.unique_integer([:positive])}")
      File.mkdir_p!(workspace)

      on_exit(fn -> File.rm_rf(workspace) end)

      write_workflow_file!(Workflow.workflow_file_path(),
        hook_before_run: "echo hook-output"
      )

      assert {:ok, [result]} = Workspace.run_before_run_hook(workspace, "TEST-HOOK")
      assert result.hook_name == "before_run"
      assert result.status == "ok"
      assert String.contains?(result.output, "hook-output")
    end

    test "run_before_run_hook returns structured results on failure" do
      workspace = Path.join(System.tmp_dir!(), "hook-test-#{System.unique_integer([:positive])}")
      File.mkdir_p!(workspace)

      on_exit(fn -> File.rm_rf(workspace) end)

      write_workflow_file!(Workflow.workflow_file_path(),
        hook_before_run: "echo failure-output && exit 1"
      )

      result =
        capture_log(fn ->
          send(self(), Workspace.run_before_run_hook(workspace, "TEST-HOOK"))
        end)

      assert_received {:error, _reason, [hook_result]}
      assert hook_result.hook_name == "before_run"
      assert hook_result.status == "failed"
      assert String.contains?(hook_result.output, "failure-output")
      assert result =~ "Workspace hook failed"
    end

    test "run_after_run_hook returns structured results on success" do
      workspace = Path.join(System.tmp_dir!(), "hook-test-#{System.unique_integer([:positive])}")
      File.mkdir_p!(workspace)

      on_exit(fn -> File.rm_rf(workspace) end)

      write_workflow_file!(Workflow.workflow_file_path(),
        hook_after_run: "echo after-output"
      )

      assert [result] = Workspace.run_after_run_hook(workspace, "TEST-HOOK")
      assert result.hook_name == "after_run"
      assert result.status == "ok"
      assert String.contains?(result.output, "after-output")
    end
  end

  describe "Store.complete_session_by_engine_session_id/2 with hook_results" do
    test "persists hook_results through engine session completion" do
      session_id = "engine-hook-test-#{System.unique_integer([:positive])}"

      {:ok, _session} =
        Store.create_session(%{
          issue_id: "hook-test-issue-#{System.unique_integer([:positive])}",
          session_id: session_id,
          status: "running",
          started_at: DateTime.utc_now(),
          organization_id: test_org_id()
        })

      hook_results = [
        %{"hook_name" => "before_run", "status" => "ok", "output" => ""},
        %{"hook_name" => "after_run", "status" => "failed", "output" => "cleanup error"}
      ]

      {:ok, updated} =
        Store.complete_session_by_engine_session_id(session_id, %{
          status: "completed",
          hook_results: hook_results
        })

      assert updated.hook_results == hook_results
    end
  end
end
