defmodule SymphonyElixirWeb.SessionLive do
  @moduledoc """
  Per-issue timeline view showing all sessions (historical + live) for an issue
  in a unified chat-style UI with real-time streaming.
  """

  use Phoenix.LiveView, layout: {SymphonyElixirWeb.Layouts, :app}

  alias Phoenix.LiveView.JS
  alias SymphonyElixir.{SessionLog, Store}
  alias SymphonyElixirWeb.{Endpoint, ObservabilityPubSub, Presenter}

  @impl true
  def mount(params, _session, socket) do
    socket =
      case load_page_context(params) do
        {:issue_timeline, issue_identifier, back_href} ->
          build_issue_timeline_socket(socket, issue_identifier, back_href)

        {:historical_session, session, back_href} ->
          build_historical_session_socket(socket, session, back_href)

        :not_found ->
          assign_not_found_socket(socket)
      end

    if connected?(socket) do
      if socket.assigns.issue_id, do: maybe_subscribe_session(socket.assigns.issue_id)
      :ok = ObservabilityPubSub.subscribe()
      if socket.assigns.runtime_clock_enabled, do: schedule_runtime_tick()
    end

    {:ok, socket}
  end

  @impl true
  def handle_info({:session_message, message}, socket) do
    message = ensure_message_dom_id(message, {:live_message, socket.assigns.session_id})
    messages = socket.assigns.messages

    # Inject the live session header before the first real message
    messages =
      if has_live_session_header?(messages) do
        messages ++ [message]
      else
        header = live_session_header(socket.assigns.session_id)

        messages ++ [header, message]
      end

    {:noreply, assign(socket, :messages, messages)}
  end

  @impl true
  def handle_info({:session_message_update, updated_message}, socket) do
    updated_message = ensure_message_dom_id(updated_message, {:live_message, socket.assigns.session_id})

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
    case socket.assigns.issue_identifier do
      issue_identifier when is_binary(issue_identifier) and issue_identifier != "" ->
        payload = load_issue_payload(issue_identifier)
        {issue_id, session_id} = extract_session_keys(payload)

        socket =
          socket
          |> assign(:payload, payload)
          |> maybe_resubscribe(issue_id, session_id)
          |> maybe_update_runtime_clock(payload)

        if session_id != socket.assigns.session_id do
          {messages, issue_title, historical_status} =
            build_full_timeline(issue_identifier, issue_id, session_id)

          socket =
            socket
            |> assign(:messages, messages)
            |> assign(:session_id, session_id)
            |> assign(:issue_title, issue_title || socket.assigns.issue_title)
            |> assign(:page_status, payload_status(payload, historical_status))

          {:noreply, socket}
        else
          {:noreply, assign(socket, :page_status, payload_status(payload, socket.assigns.page_status))}
        end

      _ ->
        {:noreply, socket}
    end
  end

  @impl true
  def handle_info(:runtime_tick, socket) do
    if socket.assigns.runtime_clock_enabled do
      schedule_runtime_tick()
      {:noreply, assign(socket, :now, DateTime.utc_now())}
    else
      {:noreply, socket}
    end
  end

  @impl true
  def render(assigns) do
    ~H"""
    <section class="chat-layout">
      <header class="chat-topbar">
        <a href={@back_href} class="chat-topbar-back" title={@back_title}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 12L6 8l4-4"/>
          </svg>
        </a>

        <div class="chat-topbar-info">
          <span class="chat-topbar-title"><%= @display_identifier %></span>
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
          <%= if @page_status do %>
            <span class={state_badge_class(@page_status)}>
              <%= @page_status %>
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
                <% @not_found -> %>
                  Session not found.
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
            <div :for={msg <- @messages} id={msg.dom_id} data-chat-entry>
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
                  <div class={"chat-tool #{if tool_failed?(msg.metadata), do: "chat-tool-failed", else: ""}"}>
                    <details
                      id={message_details_id(msg)}
                      class="chat-tool-pill"
                      phx-mounted={JS.ignore_attributes(["open"])}
                    >
                      <summary class="chat-tool-summary">
                        <span class="chat-tool-summary-copy">
                          <span class="chat-tool-summary-main">
                            <svg class="chat-tool-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                              <circle cx="8" cy="8" r="2.5"/><path d="M8 1v2m0 10v2M1 8h2m10 0h2m-2.05-4.95-1.41 1.41m-7.08 7.08-1.41 1.41m0-9.9 1.41 1.41m7.08 7.08 1.41 1.41"/>
                            </svg>
                            <span class="chat-tool-name"><%= tool_label(msg.content) %></span>
                          </span>
                          <%= if tool_context = tool_context(msg.content, msg.metadata) do %>
                            <span class="chat-tool-context" title={tool_context}><%= tool_context %></span>
                          <% end %>
                          <%= if tool_meta = tool_meta(msg.metadata) do %>
                            <span class="chat-tool-meta"><%= tool_meta %></span>
                          <% end %>
                        </span>
                        <span class={"chat-tool-badge chat-tool-badge-#{tool_status(msg.metadata)}"}>
                          <%= tool_status(msg.metadata) %>
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
                  <details
                    id={message_details_id(msg)}
                    class="chat-thinking"
                    phx-mounted={JS.ignore_attributes(["open"])}
                  >
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
          {:ok, msgs} ->
            Enum.map(msgs, &ensure_message_dom_id(&1, {:live_message, current_session_id}))

          {:error, _} ->
            []
        end
      else
        []
      end

    historical_entries =
      Enum.flat_map(past_sessions, fn session ->
        header = session_header_message(session)
        [header | historical_session_messages(session.id)]
      end)

    live_entries =
      if current_session_id && live_messages != [] do
        header = live_session_header(current_session_id)

        [header | live_messages]
      else
        []
      end

    messages = historical_entries ++ live_entries
    issue_title = extract_issue_title(past_sessions)
    latest_historical_status = latest_historical_status(past_sessions)

    {messages, issue_title, latest_historical_status}
  end

  defp session_header_message(session) do
    ensure_message_dom_id(
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
      },
      {:session_header, session.session_id, session.started_at}
    )
  end

  defp live_session_header(session_id) do
    ensure_message_dom_id(
      %{
        type: :session_header,
        content: "Live Session",
        timestamp: DateTime.utc_now(),
        metadata: %{status: "running", session_id: session_id}
      },
      {:session_header, session_id, "running"}
    )
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

  defp historical_session_messages(db_session_id) when is_integer(db_session_id) do
    Store.get_session_messages(db_session_id)
    |> Enum.map(fn m ->
      ensure_message_dom_id(
        %{
          id: m.seq,
          timestamp: m.timestamp,
          type: safe_atom_type(m.type),
          content: m.content,
          metadata: decode_metadata(m.metadata)
        },
        {:historical_message, db_session_id}
      )
    end)
  end

  defp extract_issue_title([]), do: nil

  defp extract_issue_title(sessions) do
    case List.last(sessions) do
      %{issue_title: title} when is_binary(title) and title != "" -> title
      _ -> nil
    end
  end

  defp latest_historical_status([]), do: nil

  defp latest_historical_status(sessions) do
    case List.last(sessions) do
      %{status: status} when is_binary(status) and status != "" -> status
      _ -> nil
    end
  end

  defp load_page_context(%{"issue_identifier" => issue_identifier})
       when is_binary(issue_identifier) and issue_identifier != "" do
    {:issue_timeline, issue_identifier, "/"}
  end

  defp load_page_context(%{"id" => id_str}) when is_binary(id_str) do
    with {id, ""} <- Integer.parse(id_str),
         %{issue_identifier: issue_identifier} = session <- Store.get_session(id) do
      if is_binary(issue_identifier) and issue_identifier != "" do
        {:issue_timeline, issue_identifier, "/history"}
      else
        {:historical_session, session, "/history"}
      end
    else
      _ -> :not_found
    end
  end

  defp load_page_context(_params), do: :not_found

  defp build_issue_timeline_socket(socket, issue_identifier, back_href) do
    payload = load_issue_payload(issue_identifier)
    {issue_id, session_id} = extract_session_keys(payload)
    {messages, issue_title, historical_status} = build_full_timeline(issue_identifier, issue_id, session_id)

    socket
    |> assign(:issue_identifier, issue_identifier)
    |> assign(:display_identifier, issue_identifier)
    |> assign(:issue_id, issue_id)
    |> assign(:session_id, session_id)
    |> assign(:payload, payload)
    |> assign(:messages, messages)
    |> assign(:issue_title, issue_title)
    |> assign(:page_status, payload_status(payload, historical_status))
    |> assign(:back_href, back_href)
    |> assign(:back_title, back_title(back_href))
    |> assign(:not_found, false)
    |> assign(:runtime_clock_enabled, runtime_clock_enabled?(payload))
    |> assign(:now, DateTime.utc_now())
  end

  defp build_historical_session_socket(socket, session, back_href) do
    messages = [session_header_message(session) | historical_session_messages(session.id)]
    display_identifier = session.issue_identifier || "Session ##{session.id}"

    socket
    |> assign(:issue_identifier, session.issue_identifier)
    |> assign(:display_identifier, display_identifier)
    |> assign(:issue_id, nil)
    |> assign(:session_id, session.session_id)
    |> assign(:payload, nil)
    |> assign(:messages, messages)
    |> assign(:issue_title, session.issue_title)
    |> assign(:page_status, session.status)
    |> assign(:back_href, back_href)
    |> assign(:back_title, back_title(back_href))
    |> assign(:not_found, false)
    |> assign(:runtime_clock_enabled, false)
    |> assign(:now, DateTime.utc_now())
  end

  defp assign_not_found_socket(socket) do
    socket
    |> assign(:issue_identifier, nil)
    |> assign(:display_identifier, "Session")
    |> assign(:issue_id, nil)
    |> assign(:session_id, nil)
    |> assign(:payload, nil)
    |> assign(:messages, [])
    |> assign(:issue_title, nil)
    |> assign(:page_status, nil)
    |> assign(:back_href, "/history")
    |> assign(:back_title, back_title("/history"))
    |> assign(:not_found, true)
    |> assign(:runtime_clock_enabled, false)
    |> assign(:now, DateTime.utc_now())
  end

  # ── Helpers ─────────────────────────────────────────────────────

  defp load_issue_payload(issue_identifier) when is_binary(issue_identifier) do
    case Presenter.issue_payload(issue_identifier, orchestrator(), snapshot_timeout_ms()) do
      {:ok, payload} -> payload
      {:error, _} -> nil
    end
  end

  defp load_issue_payload(_issue_identifier) do
    nil
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

  defp maybe_update_runtime_clock(socket, payload) do
    enabled = runtime_clock_enabled?(payload)
    previously_enabled = socket.assigns[:runtime_clock_enabled] || false

    if enabled and not previously_enabled do
      schedule_runtime_tick()
    end

    assign(socket, :runtime_clock_enabled, enabled)
  end

  defp runtime_clock_enabled?(%{running: running}) when is_map(running), do: true
  defp runtime_clock_enabled?(_payload), do: false

  defp payload_status(payload, fallback_status) when is_map(payload) do
    payload[:status] || fallback_status
  end

  defp payload_status(_payload, fallback_status), do: fallback_status

  defp back_title("/history"), do: "Back to history"
  defp back_title(_href), do: "Back to dashboard"

  defp tool_label("exec_command"), do: "Command"
  defp tool_label("apply_patch"), do: "Patch"

  defp tool_label(tool_name) when is_binary(tool_name), do: tool_name

  defp tool_label(_tool_name), do: "Tool"

  defp tool_context("exec_command", metadata) do
    metadata
    |> tool_args()
    |> map_value([:cmd, "cmd"])
    |> inline_text()
  end

  defp tool_context(_tool_name, metadata) do
    metadata
    |> tool_args()
    |> generic_tool_context()
  end

  defp tool_meta(metadata) do
    args = tool_args(metadata)

    [
      args |> map_value([:cwd, "cwd"]) |> short_path(),
      args |> map_value([:exit_code, "exit_code"]) |> format_exit_code()
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.join(" • ")
    |> case do
      "" -> nil
      meta -> meta
    end
  end

  defp tool_status(metadata), do: map_value(metadata, [:status, "status"]) || "unknown"

  defp tool_failed?(metadata), do: tool_status(metadata) == "failed"

  defp tool_args(metadata) when is_map(metadata) do
    case map_value(metadata, [:args, "args"]) do
      args when is_map(args) -> args
      _ -> %{}
    end
  end

  defp tool_args(_metadata), do: %{}

  defp generic_tool_context(args) when is_map(args) do
    args
    |> Enum.reject(fn {key, value} ->
      to_string(key) in ["cwd", "exit_code"] or blank_value?(value)
    end)
    |> Enum.sort_by(fn {key, _value} -> to_string(key) end)
    |> List.first()
    |> case do
      {key, value} -> "#{humanize_key(key)}: #{inline_text(value)}"
      nil -> nil
    end
  end

  defp humanize_key(key) do
    key
    |> to_string()
    |> String.replace("_", " ")
  end

  defp short_path(path) when is_binary(path) and path != "" do
    path
    |> String.trim_trailing("/")
    |> Path.basename()
    |> case do
      "." -> path
      basename when basename in ["", "/"] -> path
      basename -> basename
    end
  end

  defp short_path(_path), do: nil

  defp format_exit_code(code) when is_integer(code), do: "exit #{code}"

  defp format_exit_code(code) when is_binary(code) do
    case Integer.parse(code) do
      {parsed, ""} -> format_exit_code(parsed)
      _ -> nil
    end
  end

  defp format_exit_code(_code), do: nil

  defp map_value(map, keys) when is_map(map) and is_list(keys) do
    Enum.find_value(keys, &Map.get(map, &1))
  end

  defp inline_text(text) when is_binary(text) do
    text
    |> String.replace("\n", " ")
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
    |> truncate(88)
    |> case do
      "" -> nil
      value -> value
    end
  end

  defp inline_text(value) when is_integer(value), do: Integer.to_string(value)
  defp inline_text(value) when is_atom(value), do: value |> Atom.to_string() |> inline_text()
  defp inline_text(_value), do: nil

  defp truncate(text, max_length) when is_binary(text) and byte_size(text) > max_length do
    binary_part(text, 0, max_length - 1) <> "…"
  end

  defp truncate(text, _max_length), do: text

  defp blank_value?(value) when value in [nil, "", [], %{}], do: true
  defp blank_value?(_value), do: false

  defp ensure_message_dom_id(message, scope) when is_map(message) do
    Map.put_new(message, :dom_id, build_message_dom_id(message, scope))
  end

  defp message_details_id(%{dom_id: dom_id}) when is_binary(dom_id), do: dom_id <> "-details"

  defp build_message_dom_id(%{type: :session_header, metadata: metadata}, scope) do
    dom_id([
      "chat-entry",
      scope_label(scope),
      metadata[:session_id] || metadata["session_id"] || "session",
      metadata[:status] || metadata["status"] || "status"
    ])
  end

  defp build_message_dom_id(%{type: type, id: id}, scope) do
    dom_id(["chat-entry", scope_label(scope), type, id])
  end

  defp build_message_dom_id(message, scope) do
    dom_id([
      "chat-entry",
      scope_label(scope),
      Map.get(message, :type, "message"),
      Map.get(message, :timestamp, DateTime.utc_now()),
      Map.get(message, :content, "")
    ])
  end

  defp scope_label({label, value}) do
    dom_id_segment([label, value])
  end

  defp scope_label({label, value, extra}) do
    dom_id_segment([label, value, extra])
  end

  defp dom_id(parts) when is_list(parts) do
    parts
    |> dom_id_segment()
    |> case do
      "" -> "chat-entry"
      value -> value
    end
  end

  defp dom_id_segment(parts) when is_list(parts) do
    parts
    |> Enum.map_join("-", &dom_part/1)
    |> String.downcase()
    |> String.replace(~r/[^a-z0-9]+/, "-")
    |> String.trim("-")
  end

  defp dom_part(%DateTime{} = timestamp), do: DateTime.to_unix(timestamp, :microsecond)
  defp dom_part(value) when is_atom(value), do: Atom.to_string(value)
  defp dom_part(value) when is_binary(value), do: value
  defp dom_part(value) when is_integer(value), do: Integer.to_string(value)
  defp dom_part(value), do: inspect(value)

  defp safe_atom_type(type) when type in ~w(response tool_call thinking reasoning_summary turn_boundary error) do
    String.to_existing_atom(type)
  end

  defp safe_atom_type(_type), do: :response

  @known_metadata_keys %{
    "status" => :status,
    "args" => :args,
    "error" => :error,
    "reason" => :reason,
    "decision" => :decision
  }

  defp decode_metadata(nil), do: %{}

  defp decode_metadata(json) when is_binary(json) do
    case Jason.decode(json) do
      {:ok, map} when is_map(map) ->
        Map.new(map, fn {k, v} ->
          {Map.get(@known_metadata_keys, k, k), v}
        end)

      _ ->
        %{}
    end
  end

  defp decode_metadata(_), do: %{}

  defp schedule_runtime_tick do
    Process.send_after(self(), :runtime_tick, 1_000)
  end
end
