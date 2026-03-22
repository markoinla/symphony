defmodule SymphonyElixir.MCP.ConfigWriter do
  @moduledoc """
  Generates the MCP config JSON file that Claude Code uses to discover
  the Symphony Linear tools MCP server.
  """

  @config_filename ".symphony-mcp-config.json"

  @spec write(Path.t(), keyword()) :: {:ok, Path.t()} | {:error, term()}
  def write(workspace, opts \\ []) do
    config = build_config(opts)
    path = Path.join(workspace, @config_filename)

    case File.write(path, Jason.encode!(config, pretty: true)) do
      :ok -> {:ok, path}
      {:error, reason} -> {:error, {:mcp_config_write_failed, reason}}
    end
  end

  @spec build_config(keyword()) :: map()
  def build_config(opts \\ []) do
    escript_path = Keyword.get(opts, :escript_path, find_escript_path())
    api_key = Keyword.get(opts, :api_key, "")
    endpoint = Keyword.get(opts, :endpoint, "")

    env =
      %{}
      |> maybe_put("LINEAR_API_KEY", api_key)
      |> maybe_put("LINEAR_ENDPOINT", endpoint)

    %{
      "mcpServers" => %{
        "symphony-linear" => %{
          "command" => escript_path,
          "args" => ["mcp-server"],
          "env" => env
        }
      }
    }
  end

  defp find_escript_path do
    case System.find_executable("symphony") do
      nil -> find_local_escript()
      path -> path
    end
  end

  defp find_local_escript do
    local = Path.expand("bin/symphony")
    if File.regular?(local), do: local, else: "symphony"
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, _key, ""), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
