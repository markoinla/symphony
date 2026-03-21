defmodule SymphonyElixirWeb.HistorySessionLive do
  @moduledoc """
  Historical session detail — shows full conversation from SQLite storage.
  """

  use Phoenix.LiveView, layout: {SymphonyElixirWeb.Layouts, :app}

  alias SymphonyElixirWeb.{Presenter, ToolCallComponents}

  @impl true
  def mount(%{"id" => id_str}, _session, socket) do
    case Integer.parse(id_str) do
      {id, ""} ->
        case Presenter.historical_messages_payload(id) do
          {:ok, %{session: session, messages: messages}} ->
            socket =
              socket
              |> assign(:session, session)
              |> assign(:messages, messages)
              |> assign(:not_found, false)

            {:ok, socket}

          {:error, :not_found} ->
            {:ok, assign(socket, session: nil, messages: [], not_found: true)}
        end

      _ ->
        {:ok, assign(socket, session: nil, messages: [], not_found: true)}
    end
  end

  @impl true
  def render(assigns) do
    ~H"""
    <section class="chat-layout">
      <header class="chat-topbar">
        <a href="/history" class="chat-topbar-back" title="Back to history">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 12L6 8l4-4"/>
          </svg>
        </a>

        <%= if @session do %>
          <div class="chat-topbar-info">
            <span class="chat-topbar-title"><%= @session.issue_identifier || "Session ##{@session.id}" %></span>

            <%= if @session.issue_title do %>
              <span class="chat-topbar-meta"><%= @session.issue_title %></span>
            <% end %>
          </div>

          <div class="chat-topbar-badges">
            <span class={status_badge_class(@session.status)}>
              <%= @session.status %>
            </span>
            <span class="state-badge">Historical</span>
          </div>
        <% end %>
      </header>

      <%= if @session do %>
        <div class="history-detail-meta" style="padding: 0.5rem 0;">
          <span>Turns: <%= @session.turn_count %></span>
          <span class="history-detail-meta-sep">Tokens: <%= format_int(@session.total_tokens) %></span>
          <span class="history-detail-meta-sep"><%= format_datetime(@session.started_at) %> &rarr; <%= format_datetime(@session.ended_at) || "ongoing" %></span>
        </div>
      <% end %>

      <%= if @not_found do %>
        <div class="chat-messages" style="padding: 3rem 0; text-align: center;">
          <p class="empty-state">Session not found.</p>
        </div>
      <% else %>
        <div class="chat-thread" id="message-list">
          <%= if @messages == [] do %>
            <div class="chat-messages">
              <p class="empty-state" style="text-align: center; padding: 3rem 0;">No conversation messages recorded.</p>
            </div>
          <% else %>
            <div class="chat-messages">
              <%= for entry <- group_entries(@messages) do %>
                <%= if match?(%{type: "tool_group"}, entry) do %>
                  <div class="chat-tool-group">
                    <ToolCallComponents.tool_call
                      :for={msg <- entry.messages}
                      tool_name={msg.content}
                      metadata={msg.metadata}
                    />
                  </div>
                <% else %>
                  <div>
                    <%= case entry.type do %>
                      <% "response" -> %>
                        <div class="chat-msg">
                          <div class="chat-msg-header">
                            <div class="chat-msg-avatar">
                              <svg viewBox="0 0 16 16"><path d="M4 12l4-8 4 8"/></svg>
                            </div>
                            <span class="chat-msg-sender">Agent</span>
                            <span class="chat-msg-time"><%= format_time(entry.timestamp) %></span>
                          </div>
                          <div class="chat-msg-body"><%= entry.content %></div>
                        </div>

                      <% "reasoning_summary" -> %>
                        <div class="chat-reasoning-summary">
                          <div class="chat-reasoning-summary-header">
                            <svg class="chat-reasoning-summary-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                              <circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/>
                            </svg>
                            <span>Reasoning</span>
                          </div>
                          <div class="chat-reasoning-summary-body"><%= entry.content %></div>
                        </div>

                      <% "thinking" -> %>
                        <details class="chat-thinking">
                          <summary class="chat-thinking-toggle">
                            <svg class="chat-thinking-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M6 4l4 4-4 4"/>
                            </svg>
                            Thinking
                          </summary>
                          <div class="chat-thinking-body"><%= entry.content %></div>
                        </details>

                      <% "turn_boundary" -> %>
                        <div class="chat-divider">
                          <span class="chat-divider-text"><%= entry.content %></span>
                        </div>

                      <% "error" -> %>
                        <div class="chat-error">
                          <div class="chat-error-content"><%= entry.content %></div>
                        </div>

                      <% _ -> %>
                        <div class="chat-msg">
                          <div class="chat-msg-body"><%= entry.content %></div>
                        </div>
                    <% end %>
                  </div>
                <% end %>
              <% end %>
            </div>
          <% end %>
        </div>
      <% end %>
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

  defp format_time(ts) when is_binary(ts) do
    case DateTime.from_iso8601(ts) do
      {:ok, dt, _offset} -> Calendar.strftime(dt, "%H:%M:%S")
      _ -> ts
    end
  end

  defp format_time(_), do: ""

  defp format_datetime(nil), do: nil

  defp format_datetime(ts) when is_binary(ts) do
    case DateTime.from_iso8601(ts) do
      {:ok, dt, _offset} -> Calendar.strftime(dt, "%Y-%m-%d %H:%M")
      _ -> ts
    end
  end

  defp format_datetime(_), do: nil

  defp group_entries(messages) do
    messages
    |> Enum.chunk_by(&(Map.get(&1, :type) == "tool_call"))
    |> Enum.flat_map(fn chunk ->
      if Map.get(hd(chunk), :type) == "tool_call" do
        [%{type: "tool_group", messages: chunk}]
      else
        chunk
      end
    end)
  end
end
