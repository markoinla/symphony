defmodule SymphonyElixirWeb.HistoryLive do
  @moduledoc """
  Historical sessions list — shows past sessions from SQLite storage.
  """

  use Phoenix.LiveView, layout: {SymphonyElixirWeb.Layouts, :app}

  alias SymphonyElixir.Store
  alias SymphonyElixirWeb.Presenter

  @impl true
  def mount(_params, _session, socket) do
    projects = Store.list_projects()

    {:ok,
     socket
     |> assign(:projects, projects)
     |> assign(:selected_project_id, nil)
     |> assign(:payload, Presenter.history_payload(limit: 50))}
  end

  @impl true
  def handle_event("filter_project", %{"project_id" => ""}, socket) do
    {:noreply,
     socket
     |> assign(:selected_project_id, nil)
     |> assign(:payload, Presenter.history_payload(limit: 50))}
  end

  @impl true
  def handle_event("filter_project", %{"project_id" => id_str}, socket) do
    project_id = String.to_integer(id_str)

    {:noreply,
     socket
     |> assign(:selected_project_id, project_id)
     |> assign(:payload, Presenter.history_payload(limit: 50, project_id: project_id))}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <section class="dashboard-shell history-shell">
      <header class="dash-header history-header">
        <div class="dash-header-left history-header-copy">
          <div>
            <p class="history-eyebrow">Observability archive</p>
            <h1 class="dash-title">Session History</h1>
            <p class="history-header-subtitle">
              Review recent session logs with the same dashboard layout language used for active agents.
            </p>
          </div>
        </div>

        <div class="history-header-actions">
          <div class="dash-stats history-summary">
            <div class="dash-stat">
              <span class="dash-stat-value numeric"><%= length(@payload.sessions) %></span>
              <span class="dash-stat-label">shown</span>
            </div>
            <div class="dash-stat-sep"></div>
            <div class="dash-stat">
              <span class="dash-stat-value numeric"><%= length(@projects) %></span>
              <span class="dash-stat-label">projects</span>
            </div>
          </div>

          <a href="/" class="subtle-button history-header-link">Dashboard</a>
        </div>
      </header>

      <section class="section-card history-panel">
        <div class="section-header history-panel-header">
          <div>
            <h2 class="section-title">Recent sessions</h2>
            <p class="section-copy">
              <%= history_scope_copy(@projects, @selected_project_id) %>
            </p>
          </div>

          <%= if @projects != [] do %>
            <form phx-change="filter_project" class="project-filter history-filter">
              <label class="field-label sr-only" for="history-project-filter">Project</label>
              <select id="history-project-filter" name="project_id" class="field-input history-filter-input">
                <option value="">All projects</option>
                <option :for={p <- @projects} value={p.id} selected={@selected_project_id == p.id}><%= p.name %></option>
              </select>
            </form>
          <% end %>
        </div>

        <%= if @payload.sessions == [] do %>
          <div class="empty-dash history-empty">
            <div class="empty-dash-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 6h16M7 3h10M7 10h10M7 14h10M7 18h6"/>
              </svg>
            </div>
            <p class="empty-dash-text">No historical sessions recorded yet.</p>
            <p class="empty-dash-sub">Completed and active session logs will appear here once Symphony has work to display.</p>
          </div>
        <% else %>
          <div class="history-list">
            <a :for={session <- @payload.sessions} href={history_session_href(session)} class="history-item">
              <div class="history-item-main">
                <div class="history-item-header">
                  <span class="history-item-title"><%= session.issue_identifier || "n/a" %></span>
                  <span class={status_badge_class(session.status)}><%= session.status %></span>
                </div>
                <%= if session.issue_title do %>
                  <span class="history-item-subtitle"><%= truncate(session.issue_title, 80) %></span>
                <% end %>
                <div class="history-item-meta">
                  <span><%= format_datetime(session.started_at) %></span>
                  <%= if session.ended_at do %>
                    <span>&rarr; <%= format_datetime(session.ended_at) %></span>
                  <% end %>
                </div>
              </div>

              <div class="history-item-right">
                <div class="history-item-stats">
                  <span class="history-item-stat">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M2 4h12M2 8h8M2 12h10"/>
                    </svg>
                    <%= session.turn_count %> turns
                  </span>
                  <span class="history-item-stat">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="8" cy="8" r="6"/><path d="M8 4v4h3"/>
                    </svg>
                    <%= format_int(session.total_tokens) %> tok
                  </span>
                </div>
                <svg class="history-item-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M6 4l4 4-4 4"/>
                </svg>
              </div>
            </a>
          </div>
        <% end %>
      </section>
    </section>
    """
  end

  defp status_badge_class(status) do
    base = "state-badge"

    case status do
      "completed" -> "#{base} state-badge-active"
      "running" -> "#{base} state-badge-active"
      "failed" -> "#{base} state-badge-danger"
      "cancelled" -> "#{base} state-badge-warning"
      _ -> base
    end
  end

  defp format_int(value) when is_integer(value) do
    value
    |> Integer.to_string()
    |> String.reverse()
    |> String.replace(~r/.{3}(?=.)/, "\\0,")
    |> String.reverse()
  end

  defp format_int(_value), do: "n/a"

  defp format_datetime(nil), do: nil

  defp format_datetime(dt) when is_binary(dt) do
    case DateTime.from_iso8601(dt) do
      {:ok, parsed, _offset} -> Calendar.strftime(parsed, "%b %d, %H:%M")
      _ -> dt
    end
  end

  defp format_datetime(_), do: nil

  defp truncate(nil, _max), do: ""

  defp truncate(str, max) when byte_size(str) > max do
    String.slice(str, 0, max) <> "..."
  end

  defp truncate(str, _max), do: str

  defp history_scope_copy(projects, nil) do
    "Browse the latest sessions across #{length(projects)} tracked projects."
  end

  defp history_scope_copy(projects, selected_project_id) do
    case Enum.find(projects, &(&1.id == selected_project_id)) do
      nil -> "Browse the latest sessions across #{length(projects)} tracked projects."
      project -> "Showing the latest sessions for #{project.name}."
    end
  end

  defp history_session_href(%{id: id, issue_identifier: issue_identifier})
       when is_integer(id) and is_binary(issue_identifier) and issue_identifier != "" do
    "/session/#{URI.encode(issue_identifier)}"
  end

  defp history_session_href(%{id: id}) when is_integer(id), do: "/history/#{id}"
end
