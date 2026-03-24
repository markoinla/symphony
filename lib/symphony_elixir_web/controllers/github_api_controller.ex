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

  defp filter_repos(repos, ""), do: Enum.take(repos, 20)

  defp filter_repos(repos, query) do
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
