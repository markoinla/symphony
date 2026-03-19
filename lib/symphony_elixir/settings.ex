defmodule SymphonyElixir.Settings do
  @moduledoc """
  Reads/writes `.symphony_settings.json` — per-project local settings
  that overlay onto the WORKFLOW.md config at runtime.
  """

  alias SymphonyElixir.Workflow

  @settings_file_name ".symphony_settings.json"

  @spec file_path() :: Path.t()
  def file_path do
    Workflow.workflow_file_path()
    |> Path.dirname()
    |> Path.join(@settings_file_name)
  end

  @spec all() :: map()
  def all do
    case File.read(file_path()) do
      {:ok, content} ->
        case Jason.decode(content) do
          {:ok, map} when is_map(map) -> map
          _ -> %{}
        end

      {:error, _} ->
        %{}
    end
  end

  @spec get(String.t()) :: term()
  def get(key) when is_binary(key) do
    Map.get(all(), key)
  end

  @spec save_all(map()) :: :ok | {:error, term()}
  def save_all(params) when is_map(params) do
    clean =
      params
      |> Enum.reject(fn {_k, v} -> is_nil(v) or v == "" end)
      |> Map.new()

    path = file_path()
    tmp_path = path <> ".tmp"

    case Jason.encode(clean, pretty: true) do
      {:ok, json} ->
        with :ok <- File.write(tmp_path, json),
             :ok <- File.rename(tmp_path, path) do
          :ok
        else
          {:error, reason} ->
            File.rm(tmp_path)
            {:error, reason}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec config_overlay() :: map()
  def config_overlay do
    settings = all()

    overlay = expand_dot_keys(settings)

    # Auto-generate hook and workspace root from github.repo if not explicitly stored
    overlay
    |> maybe_auto_hook(settings)
    |> maybe_auto_workspace_root(settings)
    |> drop_nil_leaves()
  end

  @spec parse_project_slug(String.t()) :: String.t()
  def parse_project_slug(input) when is_binary(input) do
    input = String.trim(input)

    cond do
      # Linear project URL: https://linear.app/team/project/slug-xxx
      String.contains?(input, "linear.app") ->
        input
        |> URI.parse()
        |> Map.get(:path, "")
        |> String.split("/")
        |> Enum.reject(&(&1 == ""))
        |> extract_project_slug()

      true ->
        input
    end
  end

  def parse_project_slug(input), do: input

  @spec parse_organization_slug(String.t()) :: String.t() | nil
  def parse_organization_slug(input) when is_binary(input) do
    input = String.trim(input)

    if String.contains?(input, "linear.app") do
      input
      |> URI.parse()
      |> Map.get(:path, "")
      |> String.split("/")
      |> Enum.reject(&(&1 == ""))
      |> case do
        [org_slug | _] -> org_slug
        _ -> nil
      end
    else
      nil
    end
  end

  def parse_organization_slug(_input), do: nil

  @spec default_after_create_hook(String.t()) :: String.t()
  def default_after_create_hook(github_repo) when is_binary(github_repo) do
    "gh repo clone #{github_repo} . -- --depth 1"
  end

  @spec default_workspace_root(String.t()) :: String.t()
  def default_workspace_root(github_repo) when is_binary(github_repo) do
    repo_name =
      github_repo
      |> String.split("/")
      |> List.last()

    Path.join("~/code", "#{repo_name}-workspaces")
  end

  # --- Private ---

  defp expand_dot_keys(flat_map) do
    Enum.reduce(flat_map, %{}, fn {key, value}, acc ->
      parts = String.split(key, ".")
      deep_put(acc, parts, value)
    end)
  end

  defp deep_put(map, [key], value), do: Map.put(map, key, value)

  defp deep_put(map, [key | rest], value) do
    child = Map.get(map, key, %{})
    Map.put(map, key, deep_put(child, rest, value))
  end

  defp maybe_auto_workspace_root(overlay, settings) do
    github_repo = Map.get(settings, "github.repo")
    has_explicit_root = Map.has_key?(settings, "workspace.root")

    if is_binary(github_repo) and github_repo != "" and not has_explicit_root do
      root = default_workspace_root(github_repo)
      deep_put(overlay, ["workspace", "root"], root)
    else
      overlay
    end
  end

  defp maybe_auto_hook(overlay, settings) do
    github_repo = Map.get(settings, "github.repo")
    has_explicit_hook = Map.has_key?(settings, "hooks.after_create")

    if is_binary(github_repo) and github_repo != "" and not has_explicit_hook do
      hook = default_after_create_hook(github_repo)
      deep_put(overlay, ["hooks", "after_create"], hook)
    else
      overlay
    end
  end

  defp drop_nil_leaves(map) when is_map(map) do
    map
    |> Enum.reduce(%{}, fn {key, value}, acc ->
      case drop_nil_leaves(value) do
        nil -> acc
        cleaned -> Map.put(acc, key, cleaned)
      end
    end)
    |> case do
      empty when map_size(empty) == 0 -> nil
      result -> result
    end
  end

  defp drop_nil_leaves(""), do: nil
  defp drop_nil_leaves(value), do: value

  # Extract slug from URL path segments like ["team", "project", "slug-xxx"]
  # or ["team", "project", "settings", "slug-xxx"]
  defp extract_project_slug(segments) when length(segments) >= 3 do
    # The project slug is typically the last meaningful segment
    # Pattern: /workspace/project/project-slug or /workspace/project/settings/project-slug
    segments
    |> List.last()
    |> case do
      "settings" -> Enum.at(segments, -2) || List.last(segments)
      slug -> slug
    end
  end

  defp extract_project_slug(_segments), do: ""
end
