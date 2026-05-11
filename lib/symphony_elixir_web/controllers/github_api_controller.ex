defmodule SymphonyElixirWeb.GithubApiController do
  @moduledoc """
  Proxies search requests to the GitHub REST API using the stored OAuth token.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixir.GitHub.OAuth

  @github_api_url "https://api.github.com"

  @spec search_repos(Conn.t(), map()) :: Conn.t()
  def search_repos(conn, params) do
    case OAuth.current_access_token() do
      nil ->
        error_response(conn, 401, "oauth_not_connected", "GitHub OAuth is not connected")

      token ->
        do_search_repos(conn, token, params)
    end
  end

  @spec search_branches(Conn.t(), map()) :: Conn.t()
  def search_branches(conn, params) do
    repo = (params["repo"] || "") |> String.trim()

    cond do
      repo == "" ->
        error_response(conn, 400, "missing_repo", "Missing required `repo` parameter")

      not Regex.match?(~r{^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$}, repo) ->
        error_response(conn, 400, "invalid_repo", "Repo must be in the form owner/name")

      true ->
        case OAuth.current_access_token() do
          nil ->
            error_response(conn, 401, "oauth_not_connected", "GitHub OAuth is not connected")

          token ->
            do_search_branches(conn, token, repo, params)
        end
    end
  end

  defp do_search_repos(conn, token, params) do
    query = (params["q"] || "") |> String.trim() |> String.downcase()

    case github_get(token, "#{@github_api_url}/user/repos", %{
           "per_page" => "100",
           "sort" => "pushed",
           "direction" => "desc"
         }) do
      {:ok, repos} when is_list(repos) ->
        filtered = filter_repos(repos, query)
        json(conn, %{repos: Enum.map(filtered, &format_repo/1)})

      {:error, reason} ->
        error_response(
          conn,
          502,
          "github_error",
          "GitHub API request failed: #{inspect(reason)}"
        )
    end
  end

  @doc false
  @spec filter_repos(list(map()), String.t()) :: list(map())
  def filter_repos(repos, ""), do: Enum.take(repos, 20)

  def filter_repos(repos, query) do
    words = query |> String.split(~r/\s+/, trim: true)

    repos
    |> Enum.filter(fn repo ->
      full_name = String.downcase(repo["full_name"] || "")
      name = String.downcase(repo["name"] || "")

      Enum.all?(words, fn word ->
        String.contains?(full_name, word) or String.contains?(name, word)
      end)
    end)
    |> Enum.take(20)
  end

  defp do_search_branches(conn, token, repo, params) do
    query = (params["q"] || "") |> String.trim() |> String.downcase()

    case github_get(token, "#{@github_api_url}/repos/#{repo}/branches", %{
           "per_page" => "100"
         }) do
      {:ok, branches} when is_list(branches) ->
        filtered = filter_branches(branches, query)
        json(conn, %{branches: Enum.map(filtered, &format_branch/1)})

      {:error, {:github_api_status, 404, _body}} ->
        error_response(conn, 404, "repo_not_found", "Repository not found or no access")

      {:error, reason} ->
        error_response(
          conn,
          502,
          "github_error",
          "GitHub API request failed: #{inspect(reason)}"
        )
    end
  end

  @doc false
  @spec filter_branches(list(map()), String.t()) :: list(map())
  def filter_branches(branches, ""), do: Enum.take(branches, 50)

  def filter_branches(branches, query) do
    branches
    |> Enum.filter(fn branch ->
      String.contains?(String.downcase(branch["name"] || ""), query)
    end)
    |> Enum.take(50)
  end

  defp format_branch(node) do
    %{
      name: node["name"],
      protected: node["protected"] || false,
      sha: get_in(node, ["commit", "sha"])
    }
  end

  defp format_repo(node) do
    %{
      id: node["id"],
      full_name: node["full_name"],
      name: node["name"],
      owner: get_in(node, ["owner", "login"]),
      description: node["description"],
      private: node["private"],
      default_branch: node["default_branch"],
      url: node["html_url"]
    }
  end

  defp github_get(token, url, query_params) do
    full_url = "#{url}?#{URI.encode_query(query_params)}"

    case Req.get(full_url,
           headers: [
             {"authorization", "Bearer #{token}"},
             {"accept", "application/vnd.github+json"},
             {"x-github-api-version", "2022-11-28"}
           ],
           receive_timeout: 15_000
         ) do
      {:ok, %{status: 200, body: body}} ->
        {:ok, body}

      {:ok, %{status: status, body: body}} ->
        {:error, {:github_api_status, status, body}}

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
