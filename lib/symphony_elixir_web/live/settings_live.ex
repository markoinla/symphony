defmodule SymphonyElixirWeb.SettingsLive do
  @moduledoc """
  Settings page — edit per-project configuration stored in `.symphony_settings.json`.
  """

  use Phoenix.LiveView, layout: {SymphonyElixirWeb.Layouts, :app}

  alias SymphonyElixir.Settings
  alias SymphonyElixir.Workflow

  @field_keys [
    "tracker.api_key",
    "tracker.project_slug",
    "github.repo",
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
          <span class="chat-topbar-meta">Per-project configuration &middot; stored in .symphony_settings.json</span>
        </div>
      </header>

      <div style="padding-top: 0.5rem;">
        <form phx-submit="save" phx-change="validate" class="settings-form">

          <div class="section-card">
            <div class="section-header">
              <h2 class="section-title">Tracker</h2>
            </div>
            <p class="section-copy">Linear issue tracking configuration.</p>
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
              <div class="field-group">
                <label class="field-label" for="tracker_project_slug">Linear Project</label>
                <input
                  id="tracker_project_slug"
                  name="tracker.project_slug"
                  type="text"
                  value={@fields["tracker.project_slug"]}
                  class="field-input"
                  placeholder="project-slug or full Linear project URL"
                />
                <span class="field-hint">Paste a Linear project URL or enter the slug directly.</span>
                <%= if err = @errors["tracker.project_slug"] do %>
                  <span class="field-error-text"><%= err %></span>
                <% end %>
              </div>
            </div>
          </div>

          <div class="section-card">
            <div class="section-header">
              <h2 class="section-title">Repository</h2>
            </div>
            <p class="section-copy">Source repository for workspace cloning.</p>
            <div class="settings-fields" style="margin-top: 0.75rem;">
              <div class="field-group">
                <label class="field-label" for="github_repo">GitHub Repo</label>
                <input
                  id="github_repo"
                  name="github.repo"
                  type="text"
                  value={@fields["github.repo"]}
                  class="field-input"
                  placeholder="owner/repo"
                />
                <span class="field-hint">Auto-generates workspace root (~&#x2F;code&#x2F;&lt;repo&gt;-workspaces) and clone hook.</span>
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
      to_save = prepare_for_save(fields)

      case Settings.save_all(to_save) do
        :ok ->
          {:noreply,
           socket
           |> assign(fields: fields, errors: %{})
           |> put_flash(:info, "Settings saved.")}

        {:error, reason} ->
          {:noreply,
           socket
           |> assign(fields: fields, errors: errors)
           |> put_flash(:error, "Failed to save: #{inspect(reason)}")}
      end
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

  defp prepare_for_save(fields) do
    fields
    |> maybe_parse_slug()
    |> maybe_coerce_integers(["agent.max_concurrent_agents", "polling.interval_ms"])
  end

  defp maybe_parse_slug(fields) do
    case fields["tracker.project_slug"] do
      slug when is_binary(slug) and slug != "" ->
        Map.put(fields, "tracker.project_slug", Settings.parse_project_slug(slug))

      _ ->
        fields
    end
  end

  defp maybe_coerce_integers(fields, keys) do
    Enum.reduce(keys, fields, fn key, acc ->
      case acc[key] do
        val when is_binary(val) and val != "" ->
          case Integer.parse(val) do
            {n, ""} -> Map.put(acc, key, n)
            _ -> acc
          end

        _ ->
          acc
      end
    end)
  end

  defp workflow_defaults do
    case Workflow.current() do
      {:ok, %{config: config}} when is_map(config) ->
        %{
          "tracker.api_key" => get_in(config, ["tracker", "api_key"]) || "",
          "tracker.project_slug" => get_in(config, ["tracker", "project_slug"]) || "",
          "agent.max_concurrent_agents" => get_in(config, ["agent", "max_concurrent_agents"]) || "",
          "polling.interval_ms" => get_in(config, ["polling", "interval_ms"]) || "",
          "codex.command" => get_in(config, ["codex", "command"]) || ""
        }

      _ ->
        %{}
    end
  end
end
