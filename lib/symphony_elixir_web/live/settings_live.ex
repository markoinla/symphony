defmodule SymphonyElixirWeb.SettingsLive do
  @moduledoc """
  Settings page — edit global configuration stored in SQLite.
  """

  use Phoenix.LiveView, layout: {SymphonyElixirWeb.Layouts, :app}

  alias SymphonyElixir.Settings
  alias SymphonyElixir.Workflow

  @field_keys [
    "tracker.api_key",
    "agent.max_concurrent_agents",
    "polling.interval_ms",
    "codex.command"
  ]

  @impl true
  def mount(_params, _session, socket) do
    stored = Settings.all()
    defaults = workflow_defaults()

    fields =
      Map.new(@field_keys, fn key ->
        {key, Map.get(stored, key) || Map.get(defaults, key, "")}
      end)

    {:ok, assign(socket, fields: fields, errors: %{})}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <section class="chat-layout">
      <header class="chat-topbar">
        <div class="chat-topbar-info">
          <span class="chat-topbar-title">Settings</span>
          <span class="chat-topbar-meta">Global configuration</span>
        </div>
      </header>

      <div style="padding-top: 0.5rem;">
        <form phx-submit="save" phx-change="validate" class="settings-form">

          <div class="section-card">
            <div class="section-header">
              <h2 class="section-title">Authentication</h2>
            </div>
            <p class="section-copy">Credentials for external services.</p>
            <div class="settings-fields" style="margin-top: 0.75rem;">
              <div class="field-group">
                <label class="field-label" for="tracker_api_key">Linear API Key</label>
                <input
                  id="tracker_api_key"
                  name="tracker.api_key"
                  type="password"
                  value={@fields["tracker.api_key"]}
                  class="field-input"
                  placeholder="lin_api_..."
                  autocomplete="off"
                />
                <span class="field-hint">Create at Linear &rarr; Settings &rarr; API &rarr; Personal API keys</span>
                <%= if err = @errors["tracker.api_key"] do %>
                  <span class="field-error-text"><%= err %></span>
                <% end %>
              </div>
            </div>
          </div>

          <div class="section-card">
            <div class="section-header">
              <h2 class="section-title">Operational</h2>
            </div>
            <p class="section-copy">Runtime behavior tuning.</p>
            <div class="settings-fields" style="margin-top: 0.75rem;">
              <div class="field-group">
                <label class="field-label" for="max_concurrent_agents">Max Concurrent Agents</label>
                <input
                  id="max_concurrent_agents"
                  name="agent.max_concurrent_agents"
                  type="number"
                  value={@fields["agent.max_concurrent_agents"]}
                  class="field-input"
                  placeholder="5"
                  min="1"
                />
              </div>
              <div class="field-group">
                <label class="field-label" for="polling_interval_ms">Polling Interval (ms)</label>
                <input
                  id="polling_interval_ms"
                  name="polling.interval_ms"
                  type="number"
                  value={@fields["polling.interval_ms"]}
                  class="field-input"
                  placeholder="5000"
                  min="1000"
                />
              </div>
              <div class="field-group">
                <label class="field-label" for="codex_command">Codex Command</label>
                <input
                  id="codex_command"
                  name="codex.command"
                  type="text"
                  value={@fields["codex.command"]}
                  class="field-input"
                  placeholder="codex app-server"
                />
              </div>
            </div>
          </div>

          <div class="settings-actions">
            <button type="submit" class="primary">Save settings</button>
          </div>
        </form>
      </div>
    </section>
    """
  end

  @impl true
  def handle_event("validate", params, socket) do
    fields = extract_fields(params)
    errors = validate_fields(fields)
    {:noreply, assign(socket, fields: fields, errors: errors)}
  end

  @impl true
  def handle_event("save", params, socket) do
    fields = extract_fields(params)
    errors = validate_fields(fields)

    if map_size(errors) > 0 do
      {:noreply,
       socket
       |> assign(fields: fields, errors: errors)
       |> put_flash(:error, "Please fix the errors below.")}
    else
      to_save = maybe_coerce_integers(fields, ["agent.max_concurrent_agents", "polling.interval_ms"])
      :ok = Settings.save_all(to_save)

      {:noreply,
       socket
       |> assign(fields: fields, errors: %{})
       |> put_flash(:info, "Settings saved.")}
    end
  end

  defp extract_fields(params) do
    Map.new(@field_keys, fn key ->
      {key, to_string(Map.get(params, key, "")) |> String.trim()}
    end)
  end

  defp validate_fields(fields) do
    errors = %{}

    errors =
      case fields["agent.max_concurrent_agents"] do
        "" -> errors
        val -> if integer_value(val) <= 0, do: Map.put(errors, "agent.max_concurrent_agents", "Must be a positive integer"), else: errors
      end

    errors =
      case fields["polling.interval_ms"] do
        "" -> errors
        val -> if integer_value(val) <= 0, do: Map.put(errors, "polling.interval_ms", "Must be a positive integer"), else: errors
      end

    errors
  end

  defp integer_value(val) when is_binary(val) do
    case Integer.parse(val) do
      {n, ""} -> n
      _ -> -1
    end
  end

  defp integer_value(_), do: -1

  defp maybe_coerce_integers(fields, keys) do
    Enum.reduce(keys, fields, fn key, acc ->
      case acc[key] do
        val when is_binary(val) and val != "" ->
          maybe_coerce_integer(acc, key, val)

        _ ->
          acc
      end
    end)
  end

  defp maybe_coerce_integer(fields, key, value) do
    case Integer.parse(value) do
      {n, ""} -> Map.put(fields, key, n)
      _ -> fields
    end
  end

  defp workflow_defaults do
    case Workflow.current() do
      {:ok, %{config: config}} when is_map(config) ->
        %{
          "tracker.api_key" => get_in(config, ["tracker", "api_key"]) || "",
          "agent.max_concurrent_agents" => get_in(config, ["agent", "max_concurrent_agents"]) || "",
          "polling.interval_ms" => get_in(config, ["polling", "interval_ms"]) || "",
          "codex.command" => get_in(config, ["codex", "command"]) || ""
        }

      _ ->
        %{}
    end
  end
end
