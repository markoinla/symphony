defmodule SymphonyElixir.Settings do
  @moduledoc """
  Reads/writes global settings from SQLite.

  For project-specific configuration, use `config_overlay/1` with a
  `%Store.Project{}` struct to merge project fields into the overlay.
  """

  alias SymphonyElixir.Store

  @spec all() :: map()
  def all do
    Store.all_settings()
    |> Map.new(fn s -> {s.key, s.value} end)
  end

  @spec get(String.t()) :: term()
  def get(key) when is_binary(key) do
    Store.get_setting(key)
  end

  @spec save_all(map()) :: :ok
  def save_all(params) when is_map(params) do
    clean =
      params
      |> Enum.reject(fn {_k, v} -> is_nil(v) or v == "" end)
      |> Map.new(fn {k, v} -> {to_string(k), to_string(v)} end)

    Store.set_settings(clean)
  end

  @project_key :symphony_current_project

  @spec put_current_project(Store.Project.t() | nil) :: :ok
  def put_current_project(%Store.Project{} = project) do
    Process.put(@project_key, project)
    :ok
  end

  def put_current_project(nil) do
    Process.delete(@project_key)
    :ok
  end

  @spec current_project() :: Store.Project.t() | nil
  def current_project do
    Process.get(@project_key)
  end

  @spec config_overlay() :: map()
  def config_overlay do
    case current_project() do
      %Store.Project{} = project ->
        config_overlay(project)

      nil ->
        case Store.list_projects() do
          [project | _] -> config_overlay(project)
          [] -> config_overlay_from_settings(all())
        end
    end
  end

  defp config_overlay_from_settings(settings) do
    overlay = expand_dot_keys(settings)

    overlay
    |> maybe_auto_hook(settings)
    |> maybe_auto_workspace_root(settings)
    |> drop_nil_leaves()
    |> Kernel.||(%{})
  end

  @spec config_overlay(Store.Project.t()) :: map()
  def config_overlay(%Store.Project{} = project) do
    settings = all()

    project_settings =
      settings
      |> maybe_put_project_field("tracker.project_slug", project.linear_project_slug)
      |> maybe_put_project_field("tracker.organization_slug", project.linear_organization_slug)
      |> maybe_put_project_field("tracker.filter_by", project.linear_filter_by)
      |> maybe_put_project_field("tracker.label_name", project.linear_label_name)
      |> maybe_put_project_field("github.repo", project.github_repo)
      |> maybe_put_project_field("workspace.root", project.workspace_root)

    config_overlay_from_settings(project_settings)
  end

  defp maybe_put_project_field(settings, _key, nil), do: settings
  defp maybe_put_project_field(settings, _key, ""), do: settings
  defp maybe_put_project_field(settings, key, value), do: Map.put(settings, key, value)

  @spec parse_project_slug(String.t()) :: String.t()
  def parse_project_slug(input) when is_binary(input) do
    input = String.trim(input)

    if String.contains?(input, "linear.app") do
      input
      |> URI.parse()
      |> Map.get(:path, "")
      |> String.split("/")
      |> Enum.reject(&(&1 == ""))
      |> extract_project_slug()
    else
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

  @spec parse_env_vars(String.t() | nil) :: [{String.t(), String.t()}]
  def parse_env_vars(nil), do: []
  def parse_env_vars(""), do: []

  def parse_env_vars(text) when is_binary(text) do
    text
    |> String.split("\n")
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == "" or String.starts_with?(&1, "#")))
    |> Enum.flat_map(fn line ->
      case String.split(line, "=", parts: 2) do
        [key, value] ->
          key = String.trim(key)
          value = value |> String.trim() |> strip_quotes()
          if key != "", do: [{key, value}], else: []

        _ ->
          []
      end
    end)
  end

  defp strip_quotes(value) do
    cond do
      String.starts_with?(value, "\"") and String.ends_with?(value, "\"") ->
        String.slice(value, 1..-2//1)

      String.starts_with?(value, "'") and String.ends_with?(value, "'") ->
        String.slice(value, 1..-2//1)

      true ->
        value
    end
  end

  defp extract_project_slug(segments) when length(segments) >= 3 do
    segments
    |> List.last()
    |> case do
      "settings" -> Enum.at(segments, -2) || List.last(segments)
      slug -> slug
    end
  end

  defp extract_project_slug(_segments), do: ""
end
