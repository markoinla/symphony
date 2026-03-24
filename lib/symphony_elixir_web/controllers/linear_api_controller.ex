defmodule SymphonyElixirWeb.LinearApiController do
  @moduledoc """
  Proxies search requests to the Linear GraphQL API using the stored OAuth token.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixir.Linear.OAuth

  @linear_graphql_url "https://api.linear.app/graphql"

  @projects_query """
  query SearchProjects($filter: ProjectFilter, $first: Int!) {
    projects(filter: $filter, first: $first) {
      nodes {
        id
        name
        slugId
        url
        state
        teams {
          nodes {
            key
            organization {
              urlKey
            }
          }
        }
      }
    }
  }
  """

  @spec search_projects(Conn.t(), map()) :: Conn.t()
  def search_projects(conn, params) do
    case OAuth.current_access_token() do
      nil ->
        error_response(conn, 401, "oauth_not_connected", "Linear OAuth is not connected")

      token ->
        do_search_projects(conn, token, params)
    end
  end

  defp do_search_projects(conn, token, params) do
    query = (params["q"] || "") |> String.trim()
    filter = project_filter(query)
    variables = %{filter: filter, first: 20}

    case linear_graphql(token, @projects_query, variables) do
      {:ok, %{"data" => %{"projects" => %{"nodes" => nodes}}}} ->
        json(conn, %{projects: Enum.map(nodes, &format_project/1)})

      {:ok, %{"errors" => errors}} ->
        message = errors |> List.first() |> then(& &1["message"]) || "GraphQL error"
        error_response(conn, 502, "linear_error", message)

      {:error, reason} ->
        error_response(conn, 502, "linear_error", "Linear API request failed: #{inspect(reason)}")
    end
  end

  defp project_filter(""), do: %{state: %{eq: "started"}}

  defp project_filter(query) do
    words = query |> String.split(~r/\s+/, trim: true)

    name_filters = Enum.map(words, fn word -> %{name: %{containsIgnoreCase: word}} end)

    case name_filters do
      [single] -> Map.merge(single, %{state: %{in: ["started", "planned"]}})
      multiple -> %{and: multiple, state: %{in: ["started", "planned"]}}
    end
  end

  defp format_project(node) do
    team = List.first(get_in(node, ["teams", "nodes"]) || [])

    %{
      id: node["id"],
      name: node["name"],
      slug_id: node["slugId"],
      slug: build_project_slug(node["name"], node["slugId"]),
      url: node["url"],
      state: node["state"],
      organization_slug: team && get_in(team, ["organization", "urlKey"]),
      team_key: team && team["key"]
    }
  end

  defp build_project_slug(name, slug_id) when is_binary(name) and is_binary(slug_id) do
    slug =
      name
      |> String.downcase()
      |> String.replace(~r/[^a-z0-9]+/, "-")
      |> String.trim("-")

    "#{slug}-#{slug_id}"
  end

  defp build_project_slug(_name, slug_id), do: slug_id

  defp linear_graphql(token, query, variables) do
    payload = %{"query" => query, "variables" => variables}

    case Req.post(@linear_graphql_url,
           headers: [
             {"Authorization", "Bearer #{token}"},
             {"Content-Type", "application/json"}
           ],
           json: payload,
           receive_timeout: 15_000
         ) do
      {:ok, %{status: 200, body: body}} ->
        {:ok, body}

      {:ok, %{status: status}} ->
        {:error, {:linear_api_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp error_response(conn, status, code, message) do
    conn
    |> put_status(status)
    |> json(%{error: %{code: code, message: message}})
  end
end
