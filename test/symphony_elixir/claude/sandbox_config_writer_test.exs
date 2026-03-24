defmodule SymphonyElixir.Claude.SandboxConfigWriterTest do
  use SymphonyElixir.DataCase, async: true

  alias SymphonyElixir.Claude.SandboxConfigWriter

  defp sandbox_config(overrides \\ %{}) do
    Map.merge(
      %{
        enabled: true,
        allowed_domains: ["api.anthropic.com", "api.linear.app"],
        additional_read_paths: [],
        additional_write_paths: []
      },
      overrides
    )
  end

  describe "build_config/1" do
    test "returns valid sandbox settings structure" do
      config = SandboxConfigWriter.build_config(sandbox_config())

      assert %{"sandbox" => sandbox} = config
      assert sandbox["enabled"] == true
      assert %{"allowWrite" => write_paths} = sandbox["filesystem"]
      assert "./" in write_paths
    end

    test "includes allowed domains in network config" do
      config = SandboxConfigWriter.build_config(sandbox_config())

      assert config["sandbox"]["network"]["allowedDomains"] == [
               "api.anthropic.com",
               "api.linear.app"
             ]
    end

    test "omits allowedDomains when empty" do
      config = SandboxConfigWriter.build_config(sandbox_config(%{allowed_domains: []}))

      refute Map.has_key?(config["sandbox"]["network"], "allowedDomains")
    end

    test "includes additional read paths" do
      config =
        SandboxConfigWriter.build_config(sandbox_config(%{additional_read_paths: ["/usr/local/bin"]}))

      assert "/usr/local/bin" in config["sandbox"]["filesystem"]["allowRead"]
    end

    test "includes additional write paths" do
      config =
        SandboxConfigWriter.build_config(sandbox_config(%{additional_write_paths: ["/tmp/builds"]}))

      assert "/tmp/builds" in config["sandbox"]["filesystem"]["allowWrite"]
      assert "./" in config["sandbox"]["filesystem"]["allowWrite"]
    end

    test "deduplicates paths" do
      config =
        SandboxConfigWriter.build_config(sandbox_config(%{additional_write_paths: ["./", "/tmp"]}))

      write_paths = config["sandbox"]["filesystem"]["allowWrite"]
      assert length(Enum.uniq(write_paths)) == length(write_paths)
    end
  end

  describe "write/2" do
    test "creates .claude/settings.json in workspace" do
      workspace =
        Path.join(System.tmp_dir!(), "symphony-sandbox-test-#{System.unique_integer([:positive])}")

      File.mkdir_p!(workspace)

      try do
        assert :ok = SandboxConfigWriter.write(workspace, sandbox_config())

        path = Path.join([workspace, ".claude", "settings.json"])
        assert File.exists?(path)

        content = Jason.decode!(File.read!(path))
        assert content["sandbox"]["enabled"] == true
        assert "./" in content["sandbox"]["filesystem"]["allowWrite"]
      after
        File.rm_rf(workspace)
      end
    end

    test "is no-op when sandbox is disabled" do
      workspace =
        Path.join(System.tmp_dir!(), "symphony-sandbox-test-#{System.unique_integer([:positive])}")

      File.mkdir_p!(workspace)

      try do
        assert :ok = SandboxConfigWriter.write(workspace, %{enabled: false})

        path = Path.join([workspace, ".claude", "settings.json"])
        refute File.exists?(path)
      after
        File.rm_rf(workspace)
      end
    end

    test "creates .claude directory if missing" do
      workspace =
        Path.join(System.tmp_dir!(), "symphony-sandbox-test-#{System.unique_integer([:positive])}")

      File.mkdir_p!(workspace)

      try do
        refute File.dir?(Path.join(workspace, ".claude"))
        assert :ok = SandboxConfigWriter.write(workspace, sandbox_config())
        assert File.dir?(Path.join(workspace, ".claude"))
      after
        File.rm_rf(workspace)
      end
    end
  end
end
