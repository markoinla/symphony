defmodule SymphonyElixir.Claude.SandboxConfigWriter do
  @moduledoc """
  Writes `.claude/settings.json` into the workspace directory to configure
  Claude Code's bubblewrap sandbox for OS-level filesystem and network isolation.
  """

  @settings_dir ".claude"
  @settings_filename "settings.json"

  @spec write(Path.t(), map()) :: :ok | {:error, term()}
  def write(_workspace, %{enabled: false}), do: :ok
  def write(_workspace, %{enabled: nil}), do: :ok

  def write(workspace, sandbox_config) do
    config = build_config(sandbox_config)
    dir = Path.join(workspace, @settings_dir)
    path = Path.join(dir, @settings_filename)

    with :ok <- File.mkdir_p(dir),
         :ok <- File.write(path, Jason.encode!(config, pretty: true)) do
      :ok
    else
      {:error, reason} -> {:error, {:sandbox_config_write_failed, reason}}
    end
  end

  @spec build_config(map()) :: map()
  def build_config(sandbox_config) do
    allowed_domains = Map.get(sandbox_config, :allowed_domains, [])
    additional_read = Map.get(sandbox_config, :additional_read_paths, [])
    additional_write = Map.get(sandbox_config, :additional_write_paths, [])

    read_paths = build_read_paths(additional_read)
    write_paths = build_write_paths(additional_write)

    %{
      "sandbox" => %{
        "enabled" => true,
        "filesystem" =>
          %{"allowWrite" => write_paths}
          |> maybe_put_paths("allowRead", read_paths),
        "network" => maybe_put_domains(%{}, allowed_domains)
      }
    }
  end

  defp build_read_paths(additional) do
    mcp_dir = find_mcp_escript_dir()
    base = if mcp_dir, do: [mcp_dir], else: []
    Enum.uniq(base ++ additional)
  end

  defp build_write_paths(additional) do
    Enum.uniq(["./"] ++ additional)
  end

  defp find_mcp_escript_dir do
    case System.find_executable("symphony") do
      nil -> nil
      path -> Path.dirname(path)
    end
  end

  defp maybe_put_paths(map, _key, []), do: map
  defp maybe_put_paths(map, key, paths), do: Map.put(map, key, paths)

  defp maybe_put_domains(map, []), do: map
  defp maybe_put_domains(map, domains), do: Map.put(map, "allowedDomains", domains)
end
