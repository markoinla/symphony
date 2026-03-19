defmodule SymphonyElixirWeb.HistoryLive do
  @moduledoc """
  Historical sessions list — shows past sessions from SQLite storage.
  """

  use Phoenix.LiveView, layout: {SymphonyElixirWeb.Layouts, :app}

  alias SymphonyElixirWeb.Presenter

  @impl true
  def mount(_params, _session, socket) do
    payload = Presenter.history_payload(limit: 50)
    {:ok, assign(socket, :payload, payload)}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <section class="chat-layout">
      <header class="chat-topbar">
        <a href="/" class="chat-topbar-back" title="Back to dashboard">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 12L6 8l4-4"/>
          </svg>
        </a>

        <div class="chat-topbar-info">
          <span class="chat-topbar-title">Session History</span>
        </div>
      </header>

      <div style="max-width: 48rem; margin: 0 auto; width: 100%; padding-top: 0.5rem;">
        <%= if @payload.sessions == [] do %>
          <p class="empty-state" style="text-align: center; padding: 3rem 0;">No historical sessions recorded yet.</p>
        <% else %>
          <div class="history-list">
            <a :for={session <- @payload.sessions} href={"/history/#{session.id}"} class="history-item">
              <div class="history-item-main">
                <div style="display: flex; align-items: center; gap: 0.5rem;">
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
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--ink-tertiary);">
                  <path d="M6 4l4 4-4 4"/>
                </svg>
              </div>
            </a>
          </div>
        <% end %>
      </div>
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
end
