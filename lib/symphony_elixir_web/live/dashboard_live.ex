defmodule SymphonyElixirWeb.DashboardLive do
  @moduledoc """
  Live observability dashboard for Symphony.
  """

  use Phoenix.LiveView, layout: {SymphonyElixirWeb.Layouts, :app}

  alias SymphonyElixir.Store
  alias SymphonyElixirWeb.{Endpoint, ObservabilityPubSub, Presenter}
  @runtime_tick_ms 1_000

  @impl true
  def mount(_params, _session, socket) do
    projects = Store.list_projects()
    project_map = Map.new(projects, fn p -> {p.id, p} end)

    socket =
      socket
      |> assign(:payload, load_payload())
      |> assign(:project_map, project_map)
      |> assign(:now, DateTime.utc_now())

    if connected?(socket) do
      :ok = ObservabilityPubSub.subscribe()
      schedule_runtime_tick()
    end

    {:ok, socket}
  end

  @impl true
  def handle_info(:runtime_tick, socket) do
    schedule_runtime_tick()
    {:noreply, assign(socket, :now, DateTime.utc_now())}
  end

  @impl true
  def handle_info(:observability_updated, socket) do
    {:noreply,
     socket
     |> assign(:payload, load_payload())
     |> assign(:now, DateTime.utc_now())}
  end

  @impl true
  def render(assigns) do
    grouped =
      if assigns.payload[:error],
        do: [],
        else: group_agents_by_project(assigns.payload, assigns.project_map)

    assigns = assign(assigns, :project_sections, grouped)

    ~H"""
    <section class="dashboard-shell">
      <header class="dash-header">
        <div class="dash-header-left">
          <h1 class="dash-title">Symphony</h1>
          <div class="dash-status-badges">
            <span class="status-badge status-badge-live">
              <span class="status-badge-dot"></span>
              Live
            </span>
            <span class="status-badge status-badge-offline">
              <span class="status-badge-dot"></span>
              Offline
            </span>
          </div>
        </div>

        <%= unless @payload[:error] do %>
          <div class="dash-stats">
            <div class="dash-stat">
              <span class="dash-stat-value numeric"><%= @payload.counts.running %></span>
              <span class="dash-stat-label">running</span>
            </div>
            <div class="dash-stat-sep"></div>
            <div class="dash-stat">
              <span class="dash-stat-value numeric"><%= @payload.counts.retrying %></span>
              <span class="dash-stat-label">retrying</span>
            </div>
            <div class="dash-stat-sep"></div>
            <div class="dash-stat">
              <span class="dash-stat-value numeric"><%= format_int(@payload.codex_totals.total_tokens) %></span>
              <span class="dash-stat-label">tokens</span>
            </div>
            <div class="dash-stat-sep"></div>
            <div class="dash-stat">
              <span class="dash-stat-value numeric"><%= format_runtime_seconds(total_runtime_seconds(@payload, @now)) %></span>
              <span class="dash-stat-label">runtime</span>
            </div>
          </div>
        <% end %>
      </header>

      <%= if @payload[:error] do %>
        <section class="error-card">
          <h2 class="error-title">Snapshot unavailable</h2>
          <p class="error-copy">
            <strong><%= @payload.error.code %>:</strong> <%= @payload.error.message %>
          </p>
        </section>
      <% else %>
        <%= if @project_sections == [] do %>
          <div class="empty-dash">
            <div class="empty-dash-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>
            </div>
            <p class="empty-dash-text">No active agents</p>
            <p class="empty-dash-sub">Agents will appear here when Symphony starts processing issues.</p>
          </div>
        <% else %>
          <div :for={{project_name, agents} <- @project_sections} class="project-section">
            <div class="project-section-header">
              <h2 class="project-section-title"><%= project_name %></h2>
              <span class="project-section-count numeric"><%= length(agents) %></span>
            </div>

            <div class="agent-row">
              <article :for={agent <- agents} class={"agent-card #{agent_card_modifier(agent)}"}>
                <div class="agent-card-top">
                  <div class="agent-card-id-row">
                    <a class="agent-card-id" href={"/session/#{agent.issue_identifier}"}><%= agent.issue_identifier %></a>
                    <span class={state_badge_class(agent_state(agent))}><%= agent_state(agent) %></span>
                  </div>
                </div>

                <div class="agent-card-body">
                  <%= if agent.kind == :running do %>
                    <div class="agent-card-activity">
                      <span class="agent-card-activity-text"><%= agent.last_message || to_string(agent.last_event || "Waiting") %></span>
                    </div>

                    <div class="agent-card-stats">
                      <div class="agent-card-stat">
                        <span class="agent-card-stat-label">Runtime</span>
                        <span class="agent-card-stat-value numeric"><%= format_runtime_seconds(runtime_seconds_from_started_at(agent.started_at, @now)) %></span>
                      </div>
                      <div class="agent-card-stat">
                        <span class="agent-card-stat-label">Turns</span>
                        <span class="agent-card-stat-value numeric"><%= agent.turn_count || 0 %></span>
                      </div>
                      <div class="agent-card-stat">
                        <span class="agent-card-stat-label">Tokens</span>
                        <span class="agent-card-stat-value numeric"><%= format_int(agent.tokens.total_tokens) %></span>
                      </div>
                    </div>
                  <% else %>
                    <div class="agent-card-retry-info">
                      <div class="agent-card-stat">
                        <span class="agent-card-stat-label">Attempt</span>
                        <span class="agent-card-stat-value numeric"><%= agent.attempt %></span>
                      </div>
                      <div class="agent-card-stat">
                        <span class="agent-card-stat-label">Retry at</span>
                        <span class="agent-card-stat-value mono"><%= format_due_at(agent.due_at) %></span>
                      </div>
                    </div>
                    <%= if agent.error do %>
                      <div class="agent-card-error"><%= agent.error %></div>
                    <% end %>
                  <% end %>
                </div>

                <div class="agent-card-foot">
                  <a class="agent-card-link" href={"/session/#{agent.issue_identifier}"}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                    Session log
                  </a>
                </div>
              </article>
            </div>
          </div>
        <% end %>
      <% end %>
    </section>
    """
  end

  defp group_agents_by_project(payload, project_map) do
    all_agents =
      Enum.map(payload.running, &Map.put(&1, :kind, :running)) ++
        Enum.map(payload.retrying, &Map.put(&1, :kind, :retrying))

    if all_agents == [] do
      []
    else
      all_agents
      |> Enum.group_by(fn agent -> extract_project_id(agent[:workflow_name]) end)
      |> Enum.map(fn {project_id, agents} ->
        name = project_name(project_id, project_map)
        {name, agents}
      end)
      |> Enum.sort_by(fn {name, _} -> name end)
    end
  end

  defp extract_project_id(nil), do: nil

  defp extract_project_id(workflow_name) when is_binary(workflow_name) do
    case String.split(workflow_name, ":", parts: 2) do
      [_wf, id_str] ->
        case Integer.parse(id_str) do
          {id, ""} -> id
          _ -> nil
        end

      _ ->
        nil
    end
  end

  defp project_name(nil, _project_map), do: "Agents"

  defp project_name(project_id, project_map) do
    case Map.get(project_map, project_id) do
      %{name: name} -> name
      _ -> "Project #{project_id}"
    end
  end

  defp agent_state(%{kind: :running} = agent), do: agent.state
  defp agent_state(%{kind: :retrying}), do: "retrying"

  defp agent_card_modifier(%{kind: :retrying}), do: "agent-card--retrying"
  defp agent_card_modifier(_), do: ""

  defp format_due_at(nil), do: "pending"

  defp format_due_at(due_at) when is_binary(due_at) do
    case DateTime.from_iso8601(due_at) do
      {:ok, dt, _} -> Calendar.strftime(dt, "%H:%M:%S")
      _ -> due_at
    end
  end

  defp load_payload do
    Presenter.state_payload(orchestrator(), snapshot_timeout_ms())
  end

  defp orchestrator do
    Endpoint.config(:orchestrator) || SymphonyElixir.Orchestrator.default_source()
  end

  defp snapshot_timeout_ms do
    Endpoint.config(:snapshot_timeout_ms) || 15_000
  end

  defp completed_runtime_seconds(payload) do
    payload.codex_totals.seconds_running || 0
  end

  defp total_runtime_seconds(payload, now) do
    completed_runtime_seconds(payload) +
      Enum.reduce(payload.running, 0, fn entry, total ->
        total + runtime_seconds_from_started_at(entry.started_at, now)
      end)
  end

  defp format_runtime_seconds(seconds) when is_number(seconds) do
    whole_seconds = max(trunc(seconds), 0)
    mins = div(whole_seconds, 60)
    secs = rem(whole_seconds, 60)
    "#{mins}m #{secs}s"
  end

  defp runtime_seconds_from_started_at(%DateTime{} = started_at, %DateTime{} = now) do
    DateTime.diff(now, started_at, :second)
  end

  defp runtime_seconds_from_started_at(started_at, %DateTime{} = now) when is_binary(started_at) do
    case DateTime.from_iso8601(started_at) do
      {:ok, parsed, _offset} -> runtime_seconds_from_started_at(parsed, now)
      _ -> 0
    end
  end

  defp runtime_seconds_from_started_at(_started_at, _now), do: 0

  defp format_int(value) when is_integer(value) do
    value
    |> Integer.to_string()
    |> String.reverse()
    |> String.replace(~r/.{3}(?=.)/, "\\0,")
    |> String.reverse()
  end

  defp format_int(_value), do: "n/a"

  defp state_badge_class(state) do
    base = "state-badge"
    normalized = state |> to_string() |> String.downcase()

    cond do
      String.contains?(normalized, ["progress", "running", "active"]) -> "#{base} state-badge-active"
      String.contains?(normalized, ["blocked", "error", "failed"]) -> "#{base} state-badge-danger"
      String.contains?(normalized, ["todo", "queued", "pending", "retry"]) -> "#{base} state-badge-warning"
      true -> base
    end
  end

  defp schedule_runtime_tick do
    Process.send_after(self(), :runtime_tick, @runtime_tick_ms)
  end
end
