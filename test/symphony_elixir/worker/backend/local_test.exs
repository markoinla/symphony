defmodule SymphonyElixir.Worker.Backend.LocalTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Worker.Backend.Local
  alias SymphonyElixir.Worker.Lease

  describe "acquire/2" do
    test "returns a lease tagged local" do
      assert {:ok, %Lease{} = lease} = Local.acquire(%{identifier: "MT-32"})
      assert lease.backend == Local
      assert lease.host == "local"
      assert lease.id == "local:MT-32"
      assert lease.meta.identifier == "MT-32"
    end

    test "falls back to opts identifier when issue lacks one" do
      assert {:ok, %Lease{id: "local:opts-id"}} = Local.acquire(%{}, identifier: "opts-id")
    end

    test "falls back to 'issue' when no identifier is available" do
      assert {:ok, %Lease{id: "local:issue"}} = Local.acquire(%{})
    end
  end

  describe "resolve/2" do
    test "round-trips an acquired lease id" do
      {:ok, lease} = Local.acquire(%{identifier: "ABC-1"})
      assert {:ok, resolved} = Local.resolve(lease.id)
      assert resolved.host == "local"
      assert resolved.backend == Local
      assert resolved.meta.identifier == "ABC-1"
    end
  end

  describe "exec/3" do
    setup do
      {:ok, lease} = Local.acquire(%{identifier: "exec-test"})
      {:ok, lease: lease, tmp: tmp_dir()}
    end

    test "runs a command and captures stdout", %{lease: lease} do
      assert {:ok, %{exit: 0, stdout: stdout}} = Local.exec(lease, "echo hello")
      # We use `sh -lc` (login shell) to match Workspace hook execution, which
      # may emit profile init noise — assert the command output is present.
      assert stdout =~ "hello"
    end

    test "respects cwd opt", %{lease: lease, tmp: tmp} do
      assert {:ok, %{exit: 0, stdout: stdout}} = Local.exec(lease, "pwd", cwd: tmp)
      assert stdout =~ tmp
    end

    test "returns nonzero exit on failure", %{lease: lease} do
      assert {:ok, %{exit: status}} = Local.exec(lease, "false")
      assert status != 0
    end

    test "passes env vars through", %{lease: lease} do
      assert {:ok, %{exit: 0, stdout: stdout}} =
               Local.exec(lease, "echo $GREETING", env: [{"GREETING", "hi"}])

      assert stdout =~ "hi"
    end
  end

  describe "write_file/4 and read_file/3" do
    setup do
      {:ok, lease} = Local.acquire(%{identifier: "io-test"})
      {:ok, lease: lease, tmp: tmp_dir()}
    end

    test "writes content and reads it back", %{lease: lease, tmp: tmp} do
      path = Path.join(tmp, "nested/dir/file.txt")
      assert :ok = Local.write_file(lease, path, "payload")
      assert {:ok, "payload"} = Local.read_file(lease, path)
    end

    test "read_file returns error for missing path", %{lease: lease, tmp: tmp} do
      assert {:error, {:read_failed, _, _}} = Local.read_file(lease, Path.join(tmp, "missing"))
    end
  end

  describe "release/2 and touch/2" do
    test "are no-ops" do
      {:ok, lease} = Local.acquire(%{identifier: "noop"})
      assert :ok = Local.release(lease)
      assert :ok = Local.touch(lease)
    end
  end

  defp tmp_dir do
    path = Path.join(System.tmp_dir!(), "symphony-local-backend-#{System.unique_integer([:positive])}")
    File.mkdir_p!(path)
    on_exit(fn -> File.rm_rf(path) end)
    path
  end
end
