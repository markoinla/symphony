defmodule SymphonyElixir.Claude.AppServerTest do
  use SymphonyElixir.TestSupport
  alias SymphonyElixir.Claude.AppServer

  describe "start_session/2" do
    test "returns session with workspace" do
      workspace =
        Path.join(
          System.tmp_dir!(),
          "symphony-claude-test-#{System.unique_integer([:positive])}"
        )

      File.mkdir_p!(workspace)

      try do
        write_workflow_file!(Workflow.workflow_file_path(),
          workspace_root: Path.dirname(workspace)
        )

        assert {:ok, session} = AppServer.start_session(workspace)
        assert session.workspace == workspace
        assert session.worker_host == nil
        assert session.metadata == %{}
      after
        File.rm_rf(workspace)
      end
    end

    test "rejects non-existent workspace" do
      write_workflow_file!(Workflow.workflow_file_path())
      assert {:error, _} = AppServer.start_session("/nonexistent/path/abc123")
    end
  end

  describe "stop_session/1" do
    test "is a no-op and returns :ok" do
      session = %{workspace: "/tmp", worker_host: nil, metadata: %{}}
      assert :ok = AppServer.stop_session(session)
    end
  end
end
