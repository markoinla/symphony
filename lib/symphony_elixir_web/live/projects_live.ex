defmodule SymphonyElixirWeb.ProjectsLive do
  @moduledoc """
  Projects CRUD page — manage Linear project + GitHub repo pairings.
  """

  use Phoenix.LiveView, layout: {SymphonyElixirWeb.Layouts, :app}

  alias SymphonyElixir.{Settings, Store}

  @impl true
  def mount(_params, _session, socket) do
    {:ok,
     socket
     |> assign(:projects, Store.list_projects())
     |> assign(:editing, nil)
     |> assign(:form_fields, empty_form())
     |> assign(:form_errors, %{})}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <section class="chat-layout">
      <header class="chat-topbar">
        <div class="chat-topbar-info">
          <span class="chat-topbar-title">Projects</span>
          <span class="chat-topbar-meta">Link Linear projects to GitHub repos</span>
        </div>
      </header>

      <div style="padding-top: 0.5rem;">
        <div class="settings-form">
          <%= if @editing do %>
            <div class="section-card">
              <div class="section-header">
                <h2 class="section-title"><%= if @editing == :new, do: "New Project", else: "Edit Project" %></h2>
              </div>

              <form phx-submit="save_project" phx-change="validate_project" style="margin-top: 0.75rem;">
                <div class="settings-fields">
                  <div class="field-group">
                    <label class="field-label" for="project_name">Name</label>
                    <input
                      id="project_name"
                      name="name"
                      type="text"
                      value={@form_fields["name"]}
                      class="field-input"
                      placeholder="My Project"
                      autofocus
                    />
                    <%= if err = @form_errors["name"] do %>
                      <span class="field-error-text"><%= err %></span>
                    <% end %>
                  </div>
                  <div class="field-group">
                    <label class="field-label" for="project_linear_slug">Linear Project Slug</label>
                    <input
                      id="project_linear_slug"
                      name="linear_project_slug"
                      type="text"
                      value={@form_fields["linear_project_slug"]}
                      class="field-input"
                      placeholder="project-slug or Linear project URL"
                    />
                    <span class="field-hint">Paste a Linear project URL or enter the slug directly.</span>
                  </div>
                  <div class="field-group">
                    <label class="field-label" for="project_org_slug">Linear Organization</label>
                    <input
                      id="project_org_slug"
                      name="linear_organization_slug"
                      type="text"
                      value={@form_fields["linear_organization_slug"]}
                      class="field-input"
                      placeholder="your-org"
                    />
                    <span class="field-hint">Auto-filled when pasting a Linear project URL.</span>
                  </div>
                  <div class="field-group">
                    <label class="field-label" for="project_filter_by">Filter By</label>
                    <select
                      id="project_filter_by"
                      name="linear_filter_by"
                      class="field-input"
                    >
                      <option value="project" selected={@form_fields["linear_filter_by"] == "project"}>Project</option>
                      <option value="label" selected={@form_fields["linear_filter_by"] == "label"}>Label</option>
                    </select>
                  </div>
                  <%= if @form_fields["linear_filter_by"] == "label" do %>
                    <div class="field-group">
                      <label class="field-label" for="project_label_name">Label Name</label>
                      <input
                        id="project_label_name"
                        name="linear_label_name"
                        type="text"
                        value={@form_fields["linear_label_name"]}
                        class="field-input"
                        placeholder="symphony"
                      />
                      <span class="field-hint">Issues with this label will be picked up.</span>
                    </div>
                  <% end %>
                  <div class="field-group">
                    <label class="field-label" for="project_github_repo">GitHub Repo</label>
                    <input
                      id="project_github_repo"
                      name="github_repo"
                      type="text"
                      value={@form_fields["github_repo"]}
                      class="field-input"
                      placeholder="owner/repo"
                    />
                    <span class="field-hint">Auto-generates workspace root and clone hook.</span>
                  </div>
                  <div class="field-group">
                    <label class="field-label" for="project_workspace_root">Workspace Root</label>
                    <input
                      id="project_workspace_root"
                      name="workspace_root"
                      type="text"
                      value={@form_fields["workspace_root"]}
                      class="field-input"
                      placeholder="~/code/repo-workspaces (auto-derived from repo)"
                    />
                    <span class="field-hint">Leave blank to auto-derive from GitHub repo.</span>
                  </div>
                </div>

                <div class="settings-actions" style="margin-top: 1rem;">
                  <button type="submit" class="primary">Save</button>
                  <button type="button" phx-click="cancel_edit">Cancel</button>
                </div>
              </form>
            </div>
          <% else %>
            <div class="settings-actions" style="margin-bottom: 1rem;">
              <button phx-click="new_project" class="primary">New Project</button>
            </div>
          <% end %>

          <%= if @projects == [] and !@editing do %>
            <p class="empty-state" style="text-align: center; padding: 3rem 0;">No projects configured yet.</p>
          <% end %>

          <div :for={project <- @projects} class="section-card" style="margin-bottom: 0.75rem;">
            <div class="section-header">
              <div>
                <h2 class="section-title"><%= project.name %></h2>
                <p class="section-copy">
                  <%= if project.github_repo do %>
                    <span><%= project.github_repo %></span>
                  <% end %>
                  <%= if project.linear_project_slug do %>
                    <span :if={project.github_repo}> · </span>
                    <span>Linear: <%= project.linear_project_slug %></span>
                  <% end %>
                  <%= if project.linear_filter_by == "label" and project.linear_label_name do %>
                    <span> · Label: <%= project.linear_label_name %></span>
                  <% end %>
                </p>
              </div>
              <div style="display: flex; gap: 0.5rem;">
                <button class="subtle-button" phx-click="edit_project" phx-value-id={project.id}>Edit</button>
                <button class="subtle-button" phx-click="delete_project" phx-value-id={project.id} data-confirm="Delete this project?">Delete</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
    """
  end

  @impl true
  def handle_event("new_project", _params, socket) do
    {:noreply, assign(socket, editing: :new, form_fields: empty_form(), form_errors: %{})}
  end

  @impl true
  def handle_event("edit_project", %{"id" => id_str}, socket) do
    {:noreply, edit_project_socket(socket, String.to_integer(id_str))}
  end

  @impl true
  def handle_event("cancel_edit", _params, socket) do
    {:noreply, assign(socket, editing: nil, form_fields: empty_form(), form_errors: %{})}
  end

  @impl true
  def handle_event("validate_project", params, socket) do
    fields = extract_form_fields(params)
    fields = maybe_parse_linear_url(fields)
    errors = validate_form(fields)
    {:noreply, assign(socket, form_fields: fields, form_errors: errors)}
  end

  @impl true
  def handle_event("save_project", params, socket) do
    fields = extract_form_fields(params)
    fields = maybe_parse_linear_url(fields)
    errors = validate_form(fields)

    if map_size(errors) > 0 do
      {:noreply, save_project_error(socket, fields, errors)}
    else
      {:noreply, persist_project(socket, fields)}
    end
  end

  @impl true
  def handle_event("delete_project", %{"id" => id_str}, socket) do
    {:noreply, delete_project_socket(socket, String.to_integer(id_str))}
  end

  defp empty_form do
    %{
      "name" => "",
      "linear_project_slug" => "",
      "linear_organization_slug" => "",
      "linear_filter_by" => "project",
      "linear_label_name" => "",
      "github_repo" => "",
      "workspace_root" => ""
    }
  end

  defp extract_form_fields(params) do
    %{
      "name" => String.trim(Map.get(params, "name", "")),
      "linear_project_slug" => String.trim(Map.get(params, "linear_project_slug", "")),
      "linear_organization_slug" => String.trim(Map.get(params, "linear_organization_slug", "")),
      "linear_filter_by" => Map.get(params, "linear_filter_by", "project"),
      "linear_label_name" => String.trim(Map.get(params, "linear_label_name", "")),
      "github_repo" => String.trim(Map.get(params, "github_repo", "")),
      "workspace_root" => String.trim(Map.get(params, "workspace_root", ""))
    }
  end

  defp maybe_parse_linear_url(fields) do
    slug_input = fields["linear_project_slug"]

    if is_binary(slug_input) and String.contains?(slug_input, "linear.app") do
      fields
      |> Map.put("linear_project_slug", Settings.parse_project_slug(slug_input))
      |> maybe_fill_org(slug_input)
    else
      fields
    end
  end

  defp maybe_fill_org(fields, input) do
    case Settings.parse_organization_slug(input) do
      org when is_binary(org) and org != "" ->
        Map.put(fields, "linear_organization_slug", org)

      _ ->
        fields
    end
  end

  defp validate_form(fields) do
    errors = %{}

    if fields["name"] == "" do
      Map.put(errors, "name", "Name is required")
    else
      errors
    end
  end

  defp save_project_error(socket, fields, errors) do
    socket
    |> assign(form_fields: fields, form_errors: errors)
    |> put_flash(:error, "Please fix the errors below.")
  end

  defp edit_project_socket(socket, id) when is_integer(id) do
    case Store.get_project(id) do
      nil ->
        put_flash(socket, :error, "Project not found.")

      project ->
        assign(socket, editing: project.id, form_fields: project_form_fields(project), form_errors: %{})
    end
  end

  defp delete_project_socket(socket, id) when is_integer(id) do
    case Store.delete_project(id) do
      {:ok, _} ->
        socket
        |> assign(projects: Store.list_projects())
        |> put_flash(:info, "Project deleted.")

      {:error, _} ->
        put_flash(socket, :error, "Failed to delete project.")
    end
  end

  defp persist_project(socket, fields) do
    fields
    |> form_to_attrs()
    |> save_project(socket.assigns.editing)
    |> handle_project_save_result(socket)
  end

  defp save_project(attrs, :new), do: Store.create_project(attrs)
  defp save_project(attrs, id) when is_integer(id), do: Store.update_project(id, attrs)

  defp handle_project_save_result({:ok, _project}, socket) do
    socket
    |> assign(
      projects: Store.list_projects(),
      editing: nil,
      form_fields: empty_form(),
      form_errors: %{}
    )
    |> put_flash(:info, "Project saved.")
  end

  defp handle_project_save_result({:error, _reason}, socket) do
    put_flash(socket, :error, "Failed to save project.")
  end

  defp project_form_fields(project) do
    %{
      "id" => project.id,
      "name" => project.name || "",
      "linear_project_slug" => project.linear_project_slug || "",
      "linear_organization_slug" => project.linear_organization_slug || "",
      "linear_filter_by" => project.linear_filter_by || "project",
      "linear_label_name" => project.linear_label_name || "",
      "github_repo" => project.github_repo || "",
      "workspace_root" => project.workspace_root || ""
    }
  end

  defp form_to_attrs(fields) do
    %{
      name: fields["name"],
      linear_project_slug: non_empty(fields["linear_project_slug"]),
      linear_organization_slug: non_empty(fields["linear_organization_slug"]),
      linear_filter_by: fields["linear_filter_by"],
      linear_label_name: non_empty(fields["linear_label_name"]),
      github_repo: non_empty(fields["github_repo"]),
      workspace_root: non_empty(fields["workspace_root"])
    }
  end

  defp non_empty(""), do: nil
  defp non_empty(val), do: val
end
