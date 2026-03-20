defmodule SymphonyElixirWeb.SessionLive do
  @moduledoc """
  Per-issue timeline view showing all sessions (historical + live) for an issue
  in a unified chat-style UI with real-time streaming.
  """

  use Phoenix.LiveView, layout: {SymphonyElixirWeb.Layouts, :app}

  alias SymphonyElixir.{SessionLog, Store}
  alias SymphonyElixirWeb.{Endpoint, ObservabilityPubSub, Presenter}

  @impl true
  def mount(%{"issue_identifier" => issue_identifier}, _session, socket) do
    payload = load_issue_payload(issue_identifier)
    {issue_id, session_id} = extract_session_keys(payload)
    {messages, issue_title} = build_full_timeline(issue_identifier, issue_id, session_id)

    socket =
      socket
      |> assign(:issue_identifier, issue_identifier)
      |> assign(:issue_id, issue_id)
      |> assign(:session_id, session_id)
      |> assign(:payload, payload)
      |> assign(:messages, messages)
      |> assign(:issue_title, issue_title)
      |> assign(:now, DateTime.utc_now())

    if connected?(socket) do
      if issue_id, do: maybe_subscribe_session(issue_id)
      :ok = ObservabilityPubSub.subscribe()
      schedule_runtime_tick()
    end

    {:ok, socket}
  end

  @impl true
  def handle_info({:session_message, message}, socket) do
    messages = socket.assigns.messages

    # Inject the live session header before the first real message
    messages =
      if has_live_session_header?(messages) do
        messages ++ [message]
      else
        header = %{
          type: :session_header,
          content: "Live Session",
          timestamp: DateTime.utc_now(),
          metadata: %{status: "running", session_id: socket.assigns.session_id}
        }

        messages ++ [header, message]
      end

    {:noreply, assign(socket, :messages, messages)}
  end

  @impl true
  def handle_info({:session_message_update, updated_message}, socket) do
    messages =
      case List.last(socket.assigns.messages) do
        %{id: id} when id == updated_message.id ->
          List.replace_at(socket.assigns.messages, -1, updated_message)

        _ ->
          socket.assigns.messages ++ [updated_message]
      end

    {:noreply, assign(socket, :messages, messages)}
  end

  @impl true
  def handle_info(:observability_updated, socket) do
    payload = load_issue_payload(socket.assigns.issue_identifier)
    {issue_id, session_id} = extract_session_keys(payload)

    socket =
      socket
      |> assign(:payload, payload)
      |> maybe_resubscribe(issue_id, session_id)

    if session_id != socket.assigns.session_id do
      {messages, issue_title} =
        build_full_timeline(socket.assigns.issue_identifier, issue_id, session_id)

      socket =
        socket
        |> assign(:messages, messages)
        |> assign(:session_id, session_id)
        |> assign(:issue_title, issue_title || socket.assigns.issue_title)

      {:noreply, socket}
    else
      {:noreply, socket}
    end
  end

  @impl true
  def handle_info(:runtime_tick, socket) do
    schedule_runtime_tick()
    {:noreply, assign(socket, :now, DateTime.utc_now())}
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
          <span class="chat-topbar-title"><%= @issue_identifier %></span>
          <%= if @issue_title do %>
            <span class="chat-topbar-meta"><%= @issue_title %></span>
          <% end %>
          <%= if @payload && @payload[:running] do %>
            <span class="chat-topbar-meta">
              <%= format_runtime(@payload[:running][:started_at], @now) %>
            </span>
          <% end %>
        </div>

        <div class="chat-topbar-badges">
          <%= if @payload do %>
            <span class={state_badge_class(@payload[:status])}>
              <%= @payload[:status] || "unknown" %>
            </span>
          <% else %>
            <span class="state-badge">Idle</span>
          <% end %>
        </div>
      </header>

      <div class="chat-thread" id="message-list" phx-hook="ScrollBottom">
        <%= if @messages == [] do %>
          <div class="chat-messages">
            <p class="empty-state" style="text-align: center; padding: 3rem 0;">
              <%= cond do %>
                <% @session_id != nil -> %>
                  Session started, waiting for first message&hellip;
                <% @payload && @payload[:status] == "retrying" -> %>
                  Waiting for next attempt&hellip;
                <% true -> %>
                  No sessions recorded for this issue.
              <% end %>
            </p>
          </div>
        <% else %>
          <div class="chat-messages">
            <div :for={msg <- @messages}>
              <%= case msg.type do %>
                <% :session_header -> %>
                  <div class="chat-session-header">
                    <div class="chat-session-header-line"></div>
                    <div class="chat-session-header-content">
                      <span class={session_status_class(msg.metadata[:status])}>
                        <%= msg.metadata[:status] %>
                      </span>
                      <%= if msg.metadata[:turn_count] do %>
                        <span class="chat-session-header-stat">
                          <%= msg.metadata[:turn_count] %> turns
                        </span>
                      <% end %>
                      <%= if msg.metadata[:total_tokens] do %>
                        <span class="chat-session-header-stat">
                          <%= format_int(msg.metadata[:total_tokens]) %> tok
                        </span>
                      <% end %>
                      <%= if msg.metadata[:started_at] do %>
                        <span class="chat-session-header-stat">
                          <%= format_session_datetime(msg.metadata[:started_at]) %>
                        </span>
                      <% end %>
                      <span class="chat-session-header-id">
                        <%= truncate_session_id(msg.metadata[:session_id]) %>
                      </span>
                    </div>
                    <div class="chat-session-header-line"></div>
                  </div>

                <% :response -> %>
                  <div class="chat-msg">
                    <div class="chat-msg-header">
                      <div class="chat-msg-avatar">
                        <svg viewBox="0 0 16 16"><path d="M4 12l4-8 4 8"/></svg>
                      </div>
                      <span class="chat-msg-sender">Agent</span>
                      <span class="chat-msg-time"><%= format_time(msg.timestamp) %></span>
                    </div>
                    <div class="chat-msg-body"><%= msg.content %></div>
                  </div>

                <% :tool_call -> %>
                  <div class={"chat-tool #{if msg.metadata[:status] == "failed", do: "chat-tool-failed", else: ""}"}>
                    <details class="chat-tool-pill">
                      <summary class="chat-tool-summary">
                        <svg class="chat-tool-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                          <circle cx="8" cy="8" r="2.5"/><path d="M8 1v2m0 10v2M1 8h2m10 0h2m-2.05-4.95-1.41 1.41m-7.08 7.08-1.41 1.41m0-9.9 1.41 1.41m7.08 7.08 1.41 1.41"/>
                        </svg>
                        <span class="chat-tool-name"><%= msg.content %></span>
                        <span class={"chat-tool-badge chat-tool-badge-#{msg.metadata[:status] || "unknown"}"}>
                          <%= msg.metadata[:status] || "unknown" %>
                        </span>
                      </summary>
                      <%= if msg.metadata[:args] && msg.metadata[:args] != %{} do %>
                        <div class="chat-tool-body">
                          <pre class="chat-tool-args"><%= format_args(msg.metadata[:args]) %></pre>
                        </div>
                      <% end %>
                    </details>
                    <%= if msg.metadata[:error] do %>
                      <div class="chat-tool-error"><%= msg.metadata[:error] %></div>
                    <% end %>
                  </div>

                <% :reasoning_summary -> %>
                  <div class="chat-reasoning-summary">
                    <div class="chat-reasoning-summary-header">
                      <svg class="chat-reasoning-summary-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/>
                      </svg>
                      <span>Reasoning</span>
                    </div>
                    <div class="chat-reasoning-summary-body"><%= msg.content %></div>
                  </div>

                <% :thinking -> %>
                  <details class="chat-thinking">
                    <summary class="chat-thinking-toggle">
                      <svg class="chat-thinking-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M6 4l4 4-4 4"/>
                      </svg>
                      Thinking
                    </summary>
                    <div class="chat-thinking-body"><%= msg.content %></div>
                  </details>

                <% :turn_boundary -> %>
                  <div class="chat-divider">
                    <span class="chat-divider-text"><%= msg.content %></span>
                  </div>

                <% :error -> %>
                  <div class="chat-error">
                    <div class="chat-error-content"><%= msg.content %></div>
                  </div>

                <% _ -> %>
                  <div class="chat-msg">
                    <div class="chat-msg-body"><%= msg.content %></div>
                  </div>
              <% end %>
            </div>
          </div>
        <% end %>
      </div>
    </section>
    """
  end

  # ── Timeline Building ────────────────────────────────────────────

  defp build_full_timeline(issue_identifier, current_issue_id, current_session_id) do
    past_sessions = load_past_sessions(issue_identifier, current_session_id)

    live_messages =
      if current_issue_id && current_session_id do
        case SessionLog.get_messages(current_issue_id, current_session_id) do
          {:ok, msgs} -> msgs
          {:error, _} -> []
        end
      else
        []
      end

    historical_entries =
      Enum.flat_map(past_sessions, fn session ->
        header = session_header_message(session)

        messages =
          Store.get_session_messages(session.id)
          |> Enum.map(fn m ->
            %{
              id: m.seq,
              timestamp: m.timestamp,
              type: safe_atom_type(m.type),
              content: m.content,
              metadata: decode_metadata(m.metadata)
            }
          end)
          |> Presenter.merge_consecutive_messages()

        [header | messages]
      end)

    live_entries =
      if current_session_id && live_messages != [] do
        header = %{
          type: :session_header,
          content: "Live Session",
          timestamp: DateTime.utc_now(),
          metadata: %{status: "running", session_id: current_session_id}
        }

        [header | live_messages]
      else
        []
      end

    messages = historical_entries ++ live_entries
    issue_title = extract_issue_title(past_sessions)

    {messages, issue_title}
  end

  defp session_header_message(session) do
    %{
      type: :session_header,
      content: session.status,
      timestamp: session.started_at,
      metadata: %{
        status: session.status,
        started_at: session.started_at,
        ended_at: session.ended_at,
        turn_count: session.turn_count,
        total_tokens: session.total_tokens,
        session_id: session.session_id
      }
    }
  end

  defp has_live_session_header?(messages) do
    Enum.any?(messages, fn m ->
      m.type == :session_header and m.metadata[:status] == "running"
    end)
  end

  defp load_past_sessions(issue_identifier, current_session_id) do
    Store.list_sessions(issue_identifier: issue_identifier, limit: 50)
    |> Enum.reject(fn s -> current_session_id && s.session_id == current_session_id end)
    |> Enum.reverse()
  end

  defp extract_issue_title([]), do: nil

  defp extract_issue_title(sessions) do
    case List.last(sessions) do
      %{issue_title: title} when is_binary(title) and title != "" -> title
      _ -> nil
    end
  end

  # ── Helpers ─────────────────────────────────────────────────────

  defp load_issue_payload(issue_identifier) do
    case Presenter.issue_payload(issue_identifier, orchestrator(), snapshot_timeout_ms()) do
      {:ok, payload} -> payload
      {:error, _} -> nil
    end
  end

  defp extract_session_keys(nil), do: {nil, nil}

  defp extract_session_keys(payload) do
    issue_id = payload[:issue_id]

    session_id =
      case payload[:running] do
        %{session_id: sid} when is_binary(sid) -> sid
        _ -> nil
      end

    {issue_id, session_id}
  end

  defp maybe_resubscribe(socket, issue_id, _session_id) do
    old_issue_id = socket.assigns.issue_id

    if issue_id && issue_id != old_issue_id do
      if old_issue_id, do: ObservabilityPubSub.unsubscribe_session(old_issue_id)
      ObservabilityPubSub.subscribe_session(issue_id)
      assign(socket, :issue_id, issue_id)
    else
      socket
    end
  end

  defp orchestrator do
    Endpoint.config(:orchestrator) || SymphonyElixir.Orchestrator.default_source()
  end

  defp snapshot_timeout_ms do
    Endpoint.config(:snapshot_timeout_ms) || 15_000
  end

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

  defp session_status_class(status) do
    base = "state-badge"

    case status do
      "completed" -> "#{base} state-badge-active"
      "running" -> "#{base} state-badge-active"
      "failed" -> "#{base} state-badge-danger"
      "cancelled" -> "#{base} state-badge-warning"
      _ -> base
    end
  end

  defp format_runtime(nil, _now), do: "n/a"

  defp format_runtime(started_at, now) when is_binary(started_at) do
    case DateTime.from_iso8601(started_at) do
      {:ok, parsed, _offset} -> format_runtime(parsed, now)
      _ -> "n/a"
    end
  end

  defp format_runtime(%DateTime{} = started_at, %DateTime{} = now) do
    seconds = max(DateTime.diff(now, started_at, :second), 0)
    mins = div(seconds, 60)
    secs = rem(seconds, 60)
    "#{mins}m #{secs}s"
  end

  defp format_time(%DateTime{} = dt), do: Calendar.strftime(dt, "%H:%M:%S")
  defp format_time(_), do: ""

  defp format_session_datetime(%DateTime{} = dt), do: Calendar.strftime(dt, "%b %d, %H:%M")

  defp format_session_datetime(dt) when is_binary(dt) do
    case DateTime.from_iso8601(dt) do
      {:ok, parsed, _offset} -> format_session_datetime(parsed)
      _ -> dt
    end
  end

  defp format_session_datetime(_), do: ""

  defp truncate_session_id(nil), do: ""
  defp truncate_session_id(id) when byte_size(id) > 12, do: String.slice(id, 0, 8) <> "..."
  defp truncate_session_id(id), do: id

  defp format_int(value) when is_integer(value) do
    value
    |> Integer.to_string()
    |> String.reverse()
    |> String.replace(~r/.{3}(?=.)/, "\\0,")
    |> String.reverse()
  end

  defp format_int(_), do: "n/a"

  defp format_args(args) when is_map(args) do
    Jason.encode!(args, pretty: true)
  rescue
    _ -> inspect(args, pretty: true)
  end

  defp format_args(_), do: ""

  defp maybe_subscribe_session(issue_id) when is_binary(issue_id) do
    :ok = ObservabilityPubSub.subscribe_session(issue_id)
  end

  defp maybe_subscribe_session(_issue_id), do: :ok

  defp safe_atom_type(type) when type in ~w(response tool_call thinking reasoning_summary turn_boundary error) do
    String.to_existing_atom(type)
  end

  defp safe_atom_type(_type), do: :response

  defp decode_metadata(nil), do: %{}

  defp decode_metadata(json) when is_binary(json) do
    case Jason.decode(json) do
      {:ok, map} when is_map(map) ->
        Map.new(map, fn {k, v} ->
          {String.to_existing_atom(k), v}
        end)

      _ ->
        %{}
    end
  rescue
    ArgumentError -> %{}
  end

  defp decode_metadata(_), do: %{}

  defp schedule_runtime_tick do
    Process.send_after(self(), :runtime_tick, 1_000)
  end
end
