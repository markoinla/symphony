defmodule SymphonyElixirWeb.AgentApiController do
  @moduledoc """
  JSON API for agent workflows.

  Merges persisted agent rows with live WorkflowStore data to produce
  the agents list consumed by the dashboard. Supports toggling agent
  enabled/disabled state via PATCH.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixir.{Config, Store, WorkflowStore}
  alias SymphonyElixirWeb.ObservabilityPubSub

  @redacted_keys ~w(api_key webhook_signing_secret)

  @spec index(Conn.t(), map()) :: Conn.t()
  def index(conn, _params) do
    db_agents = Store.list_agents() |> Map.new(&{&1.name, &1})
    workflows = workflow_data()

    all_names =
      MapSet.union(
        MapSet.new(Map.keys(db_agents)),
        MapSet.new(Map.keys(workflows))
      )

    agents =
      all_names
      |> Enum.sort()
      |> Enum.map(fn name ->
        db_agent = Map.get(db_agents, name)
        workflow = Map.get(workflows, name)
        build_agent_payload(name, db_agent, workflow)
      end)

    json(conn, %{agents: agents})
  end

  @spec update(Conn.t(), map()) :: Conn.t()
  def update(conn, %{"name" => name} = params) do
    attrs = Map.take(params, ["enabled"])

    case Store.update_agent(name, atomize_keys(attrs)) do
      {:ok, agent} ->
        ObservabilityPubSub.broadcast_agents_changed()
        workflows = workflow_data()
        workflow = Map.get(workflows, agent.name)
        json(conn, %{agent: build_agent_payload(agent.name, agent, workflow)})

      {:error, :not_found} ->
        conn |> put_status(404) |> json(%{error: %{message: "Agent not found"}})

      {:error, changeset} ->
        conn |> put_status(422) |> json(%{error: %{message: "Validation failed", details: changeset_errors(changeset)}})
    end
  end

  defp atomize_keys(map) do
    Map.new(map, fn {k, v} -> {String.to_existing_atom(k), v} end)
  end

  defp changeset_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, _opts} -> msg end)
  end

  defp build_agent_payload(name, db_agent, workflow) do
    enabled = if db_agent, do: db_agent.enabled, else: true
    loaded = workflow != nil

    {description, config, raw_config} =
      if workflow do
        {workflow.description, workflow.config_summary, redact(workflow.raw_config)}
      else
        {nil, %{}, %{}}
      end

    %{
      name: name,
      enabled: enabled,
      loaded: loaded,
      description: description,
      config: config,
      raw_config: raw_config
    }
  end

  defp workflow_data do
    case WorkflowStore.all() do
      {:ok, workflows} ->
        Map.new(workflows, fn {name, workflow} ->
          {name, extract_workflow_info(name, workflow)}
        end)

      {:error, _reason} ->
        %{}
    end
  end

  defp extract_workflow_info(name, workflow) do
    settings =
      case Config.workflow_settings(name) do
        {:ok, settings} -> settings
        {:error, _reason} -> nil
      end

    description = settings && settings.description

    config_summary =
      if settings do
        %{
          max_concurrent_agents: settings.agent.max_concurrent_agents,
          polling_interval_ms: settings.polling.interval_ms,
          max_turns: settings.agent.max_turns,
          engine: settings.engine
        }
      else
        %{}
      end

    raw_config = workflow.config || %{}

    %{description: description, config_summary: config_summary, raw_config: raw_config}
  end

  defp redact(config) when is_map(config) do
    Enum.reduce(config, %{}, fn {key, value}, acc ->
      str_key = to_string(key)

      cond do
        str_key in @redacted_keys ->
          Map.put(acc, key, "[REDACTED]")

        is_map(value) ->
          Map.put(acc, key, redact(value))

        true ->
          Map.put(acc, key, value)
      end
    end)
  end

  defp redact(value), do: value
end
