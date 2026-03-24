defmodule SymphonyElixirWeb.ProjectApiController do
  @moduledoc """
  JSON CRUD API for tracked projects.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixir.{Settings, Store}
  alias SymphonyElixirWeb.{ObservabilityPubSub, Presenter}

  import SymphonyElixirWeb.ErrorHelpers, only: [error_response: 4, changeset_error_response: 4]

  @spec index(Conn.t(), map()) :: Conn.t()
  def index(conn, _params) do
    json(conn, Presenter.projects_payload())
  end

  @spec show(Conn.t(), map()) :: Conn.t()
  def show(conn, %{"id" => id}) do
    with {project_id, ""} <- Integer.parse(id),
         {:ok, payload} <- Presenter.project_lookup_payload(project_id) do
      json(conn, payload)
    else
      :error -> error_response(conn, 404, "project_not_found", "Project not found")
      {:error, :not_found} -> error_response(conn, 404, "project_not_found", "Project not found")
    end
  end

  @spec create(Conn.t(), map()) :: Conn.t()
  def create(conn, params) do
    case Store.create_project(project_attrs(params)) do
      {:ok, project} ->
        ObservabilityPubSub.broadcast_projects_changed()

        conn
        |> put_status(:created)
        |> json(%{project: project_payload(project)})

      {:error, changeset} ->
        changeset_error_response(conn, "invalid_project", "Project is invalid", changeset)
    end
  end

  @spec update(Conn.t(), map()) :: Conn.t()
  def update(conn, %{"id" => id} = params) do
    case Integer.parse(id) do
      {project_id, ""} ->
        case Store.update_project(project_id, project_attrs(params)) do
          {:ok, project} ->
            ObservabilityPubSub.broadcast_projects_changed()
            json(conn, %{project: project_payload(project)})

          {:error, :not_found} ->
            error_response(conn, 404, "project_not_found", "Project not found")

          {:error, changeset} ->
            changeset_error_response(conn, "invalid_project", "Project is invalid", changeset)
        end

      _ ->
        error_response(conn, 404, "project_not_found", "Project not found")
    end
  end

  @spec delete(Conn.t(), map()) :: Conn.t()
  def delete(conn, %{"id" => id}) do
    with {project_id, ""} <- Integer.parse(id),
         {:ok, _project} <- Store.delete_project(project_id) do
      ObservabilityPubSub.broadcast_projects_changed()
      send_resp(conn, 204, "")
    else
      :error -> error_response(conn, 404, "project_not_found", "Project not found")
      {:error, :not_found} -> error_response(conn, 404, "project_not_found", "Project not found")
    end
  end

  defp project_attrs(params) do
    slug_input = trimmed(params["linear_project_slug"])

    linear_project_slug =
      if String.contains?(slug_input, "linear.app") do
        Settings.parse_project_slug(slug_input)
      else
        blank_to_nil(slug_input)
      end

    linear_organization_slug =
      params["linear_organization_slug"]
      |> trimmed()
      |> blank_to_nil()
      |> maybe_fill_organization_slug(slug_input)

    %{
      name: trimmed(params["name"]),
      linear_project_slug: linear_project_slug,
      linear_organization_slug: linear_organization_slug,
      linear_filter_by: normalize_filter_by(params["linear_filter_by"]),
      linear_label_name: params["linear_label_name"] |> trimmed() |> blank_to_nil(),
      github_repo: params["github_repo"] |> trimmed() |> blank_to_nil(),
      github_branch: params["github_branch"] |> trimmed() |> blank_to_nil(),
      workspace_root: params["workspace_root"] |> trimmed() |> blank_to_nil(),
      env_vars: Map.get(params, "env_vars", "") |> blank_to_nil()
    }
  end

  defp normalize_filter_by("label"), do: "label"
  defp normalize_filter_by(_value), do: "project"

  defp maybe_fill_organization_slug(nil, input) when is_binary(input) do
    case Settings.parse_organization_slug(input) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp maybe_fill_organization_slug(value, _input), do: value

  defp project_payload(project) do
    %{project: item} = Presenter.project_lookup_payload(project.id) |> elem(1)
    item
  end

  defp trimmed(nil), do: ""
  defp trimmed(value), do: value |> to_string() |> String.trim()

  defp blank_to_nil(""), do: nil
  defp blank_to_nil(value), do: value
end
