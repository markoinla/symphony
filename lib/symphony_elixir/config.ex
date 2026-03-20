defmodule SymphonyElixir.Config do
  @moduledoc """
  Runtime configuration loaded from `WORKFLOW.md`.
  """

  alias SymphonyElixir.Config.Schema
  alias SymphonyElixir.Workflow

  @default_prompt_template """
  You are working on a Linear issue.

  Identifier: {{ issue.identifier }}
  Title: {{ issue.title }}

  Body:
  {% if issue.description %}
  {{ issue.description }}
  {% else %}
  No description provided.
  {% endif %}
  """

  @type codex_runtime_settings :: %{
          approval_policy: String.t() | map(),
          thread_sandbox: String.t(),
          turn_sandbox_policy: map()
        }

  @spec settings() :: {:ok, Schema.t()} | {:error, term()}
  def settings do
    settings(Workflow.current_workflow_name())
  end

  @spec settings(String.t()) :: {:ok, Schema.t()} | {:error, term()}
  def settings(workflow_name) when is_binary(workflow_name) do
    case Workflow.current(workflow_name) do
      {:ok, %{config: config}} when is_map(config) ->
        merged = deep_merge(SymphonyElixir.Settings.config_overlay(), config)
        Schema.parse(merged)

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec settings(String.t(), SymphonyElixir.Store.Project.t()) :: {:ok, Schema.t()} | {:error, term()}
  def settings(workflow_name, %SymphonyElixir.Store.Project{} = project) when is_binary(workflow_name) do
    case Workflow.current(workflow_name) do
      {:ok, %{config: config}} when is_map(config) ->
        merged = deep_merge(SymphonyElixir.Settings.config_overlay(project), config)
        Schema.parse(merged)

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec settings!() :: Schema.t()
  def settings! do
    settings!(Workflow.current_workflow_name())
  end

  @spec settings!(String.t()) :: Schema.t()
  def settings!(workflow_name) when is_binary(workflow_name) do
    case settings(workflow_name) do
      {:ok, settings} ->
        settings

      {:error, reason} ->
        raise ArgumentError, message: format_config_error(reason)
    end
  end

  @spec max_concurrent_agents_for_state(term()) :: pos_integer()
  def max_concurrent_agents_for_state(state_name) when is_binary(state_name) do
    config = settings!()

    Map.get(
      config.agent.max_concurrent_agents_by_state,
      Schema.normalize_issue_state(state_name),
      config.agent.max_concurrent_agents
    )
  end

  def max_concurrent_agents_for_state(_state_name), do: settings!().agent.max_concurrent_agents

  @spec codex_turn_sandbox_policy(Path.t() | nil) :: map()
  def codex_turn_sandbox_policy(workspace \\ nil) do
    case Schema.resolve_runtime_turn_sandbox_policy(settings!(), workspace) do
      {:ok, policy} ->
        policy

      {:error, reason} ->
        raise ArgumentError, message: "Invalid codex turn sandbox policy: #{inspect(reason)}"
    end
  end

  @spec workflow_prompt() :: String.t()
  def workflow_prompt do
    workflow_prompt(Workflow.current_workflow_name())
  end

  @spec workflow_prompt(String.t()) :: String.t()
  def workflow_prompt(workflow_name) when is_binary(workflow_name) do
    case Workflow.current(workflow_name) do
      {:ok, %{prompt_template: prompt}} ->
        if String.trim(prompt) == "", do: @default_prompt_template, else: prompt

      _ ->
        @default_prompt_template
    end
  end

  @spec server_port() :: non_neg_integer() | nil
  def server_port do
    server_port(Workflow.default_workflow_name())
  end

  @spec server_port(String.t()) :: non_neg_integer() | nil
  def server_port(workflow_name) when is_binary(workflow_name) do
    case Application.get_env(:symphony_elixir, :server_port_override) do
      port when is_integer(port) and port >= 0 -> port
      _ -> settings!(workflow_name).server.port
    end
  end

  @spec validate!() :: :ok | {:error, term()}
  def validate! do
    validate!(Workflow.current_workflow_name())
  end

  @spec validate!(String.t()) :: :ok | {:error, term()}
  def validate!(workflow_name) when is_binary(workflow_name) do
    with {:ok, settings} <- settings(workflow_name) do
      validate_semantics(settings)
    end
  end

  @spec codex_runtime_settings(Path.t() | nil, keyword()) ::
          {:ok, codex_runtime_settings()} | {:error, term()}
  def codex_runtime_settings(workspace \\ nil, opts \\ []) do
    with {:ok, settings} <- settings() do
      with {:ok, turn_sandbox_policy} <-
             Schema.resolve_runtime_turn_sandbox_policy(settings, workspace, opts) do
        {:ok,
         %{
           approval_policy: settings.codex.approval_policy,
           thread_sandbox: settings.codex.thread_sandbox,
           turn_sandbox_policy: turn_sandbox_policy
         }}
      end
    end
  end

  defp validate_semantics(settings) do
    cond do
      is_nil(settings.tracker.kind) ->
        {:error, :missing_tracker_kind}

      settings.tracker.kind not in ["linear", "memory"] ->
        {:error, {:unsupported_tracker_kind, settings.tracker.kind}}

      settings.tracker.kind == "linear" ->
        validate_linear_semantics(settings.tracker)

      true ->
        :ok
    end
  end

  defp validate_linear_semantics(tracker) do
    cond do
      not is_binary(tracker.api_key) ->
        {:error, :missing_linear_api_token}

      tracker.filter_by == "project" and not is_binary(tracker.project_slug) ->
        {:error, :missing_linear_project_slug}

      tracker.filter_by == "label" and not is_binary(tracker.label_name) ->
        {:error, :missing_linear_label_name}

      tracker.filter_by not in ["project", "label"] ->
        {:error, {:unsupported_linear_filter_by, tracker.filter_by}}

      true ->
        :ok
    end
  end

  defp deep_merge(base, overlay) when is_map(base) and is_map(overlay) do
    Map.merge(base, overlay, fn
      _key, base_val, overlay_val when is_map(base_val) and is_map(overlay_val) ->
        deep_merge(base_val, overlay_val)

      _key, base_val, nil ->
        base_val

      _key, _base_val, overlay_val ->
        overlay_val
    end)
  end

  defp format_config_error(reason) do
    case reason do
      {:invalid_workflow_config, message} ->
        "Invalid WORKFLOW.md config: #{message}"

      {:missing_workflow_file, path, raw_reason} ->
        "Missing WORKFLOW.md at #{path}: #{inspect(raw_reason)}"

      {:workflow_parse_error, raw_reason} ->
        "Failed to parse WORKFLOW.md: #{inspect(raw_reason)}"

      :workflow_front_matter_not_a_map ->
        "Failed to parse WORKFLOW.md: workflow front matter must decode to a map"

      other ->
        "Invalid WORKFLOW.md config: #{inspect(other)}"
    end
  end
end
