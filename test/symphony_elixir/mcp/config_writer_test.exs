defmodule SymphonyElixir.MCP.ConfigWriterTest do
  use SymphonyElixir.TestSupport
  alias SymphonyElixir.MCP.ConfigWriter

  test "build_config returns valid MCP config structure" do
    config = ConfigWriter.build_config(escript_path: "/usr/local/bin/symphony", api_key: "test-key", endpoint: "https://custom.endpoint/graphql")

    assert %{"mcpServers" => %{"symphony-linear" => server}} = config
    assert server["command"] == "/usr/local/bin/symphony"
    assert server["args"] == ["mcp-server"]
    assert server["env"]["LINEAR_API_KEY"] == "test-key"
    assert server["env"]["LINEAR_ENDPOINT"] == "https://custom.endpoint/graphql"
  end

  test "build_config includes oauth token when provided" do
    config = ConfigWriter.build_config(escript_path: "/bin/symphony", oauth_token: "oauth-tok", endpoint: "")

    server = config["mcpServers"]["symphony-linear"]
    assert server["env"]["LINEAR_OAUTH_TOKEN"] == "oauth-tok"
    refute Map.has_key?(server["env"], "LINEAR_API_KEY")
  end

  test "build_config omits empty env vars" do
    config = ConfigWriter.build_config(escript_path: "/bin/symphony", api_key: "", oauth_token: "", endpoint: "")

    server = config["mcpServers"]["symphony-linear"]
    refute Map.has_key?(server["env"], "LINEAR_API_KEY")
    refute Map.has_key?(server["env"], "LINEAR_OAUTH_TOKEN")
    refute Map.has_key?(server["env"], "LINEAR_ENDPOINT")
  end

  test "write creates JSON file in workspace" do
    workspace = Path.join(System.tmp_dir!(), "symphony-mcp-test-#{System.unique_integer([:positive])}")
    File.mkdir_p!(workspace)

    try do
      assert {:ok, path} =
               ConfigWriter.write(workspace,
                 escript_path: "/bin/symphony",
                 api_key: "tok",
                 endpoint: "https://api.linear.app/graphql"
               )

      assert String.ends_with?(path, ".symphony-mcp-config.json")
      assert File.exists?(path)

      content = Jason.decode!(File.read!(path))
      assert content["mcpServers"]["symphony-linear"]["command"] == "/bin/symphony"
    after
      File.rm_rf(workspace)
    end
  end
end
