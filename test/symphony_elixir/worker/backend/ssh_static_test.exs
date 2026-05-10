defmodule SymphonyElixir.Worker.Backend.SSHStaticTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.Worker.Backend.SSHStatic
  alias SymphonyElixir.Worker.Lease

  describe "acquire/2" do
    test "returns a lease tagged with the configured host" do
      assert {:ok, %Lease{} = lease} =
               SSHStatic.acquire(%{identifier: "MT-32"}, host: "worker-1.example:2200")

      assert lease.backend == SSHStatic
      assert lease.host == "worker-1.example:2200"
      assert lease.id == "ssh:worker-1.example:2200:MT-32"
      assert lease.meta.ssh_target == "worker-1.example:2200"
    end

    test "errors when no host is supplied" do
      assert {:error, :missing_ssh_host} = SSHStatic.acquire(%{identifier: "MT-32"})
    end
  end

  describe "resolve/2" do
    test "round-trips an acquired lease id" do
      {:ok, lease} = SSHStatic.acquire(%{identifier: "MT-32"}, host: "worker-1.example")
      assert {:ok, resolved} = SSHStatic.resolve(lease.id)
      assert resolved.host == "worker-1.example"
      assert resolved.meta.ssh_target == "worker-1.example"
    end

    test "rejects malformed ids" do
      assert {:error, :invalid_lease_id} = SSHStatic.resolve("not-an-ssh-lease")
    end
  end

  describe "exec/3 (with fake ssh)" do
    setup do
      test_root = Path.join(System.tmp_dir!(), "symphony-ssh-static-#{System.unique_integer([:positive])}")
      trace_file = Path.join(test_root, "ssh.trace")
      previous_path = System.get_env("PATH")

      install_fake_ssh!(test_root, trace_file)

      on_exit(fn ->
        restore_env("PATH", previous_path)
        File.rm_rf(test_root)
      end)

      {:ok, lease} = SSHStatic.acquire(%{identifier: "T-1"}, host: "worker.example:2200")

      {:ok, lease: lease, trace_file: trace_file}
    end

    test "runs through SSH.run with the lease host", %{lease: lease, trace_file: trace_file} do
      assert {:ok, %{exit: 0, stdout: ""}} = SSHStatic.exec(lease, "echo hi")
      trace = File.read!(trace_file)
      assert trace =~ "-T -p 2200 worker.example bash -lc"
      assert trace =~ "echo hi"
    end

    test "prefixes cwd when supplied", %{lease: lease, trace_file: trace_file} do
      assert {:ok, %{exit: 0}} = SSHStatic.exec(lease, "pwd", cwd: "/tmp/work")
      # Trace contains the doubly-escaped argv (SSH wraps in `bash -lc <escaped>`
      # and `set` re-quotes for the trace). Just verify the meaningful tokens.
      trace = File.read!(trace_file)
      assert trace =~ "cd "
      assert trace =~ "/tmp/work"
      assert trace =~ "pwd"
    end

    test "exports env vars when supplied", %{lease: lease, trace_file: trace_file} do
      assert {:ok, %{exit: 0}} =
               SSHStatic.exec(lease, "env", env: [{"FOO", "bar"}, {"BAZ", "qux"}])

      trace = File.read!(trace_file)
      assert trace =~ "export FOO="
      assert trace =~ "bar"
      assert trace =~ "export BAZ="
      assert trace =~ "qux"
    end
  end

  describe "release/2 and touch/2" do
    test "are no-ops" do
      {:ok, lease} = SSHStatic.acquire(%{identifier: "x"}, host: "h")
      assert :ok = SSHStatic.release(lease)
      assert :ok = SSHStatic.touch(lease)
    end
  end

  defp install_fake_ssh!(test_root, trace_file) do
    fake_bin_dir = Path.join(test_root, "bin")
    fake_ssh = Path.join(fake_bin_dir, "ssh")
    File.mkdir_p!(fake_bin_dir)

    File.write!(fake_ssh, """
    #!/bin/sh
    printf 'ARGV:%s\\n' "$*" >> "#{trace_file}"
    exit 0
    """)

    File.chmod!(fake_ssh, 0o755)
    System.put_env("PATH", fake_bin_dir <> ":" <> (System.get_env("PATH") || ""))
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)
end
