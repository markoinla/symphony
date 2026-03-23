defmodule SymphonyElixir.MCP.LinearTools do
  @moduledoc """
  Self-contained Linear tool implementations for the MCP server.

  Uses `:httpc` directly (no Req dependency) so the MCP escript stays lightweight.
  Reads `LINEAR_OAUTH_TOKEN` (preferred) or `LINEAR_API_KEY` and `LINEAR_ENDPOINT`
  from the environment.
  """

  @default_endpoint "https://api.linear.app/graphql"
  @agent_reply_tag "<!-- symphony:agent-reply -->"

  @spec tool_definitions() :: [map()]
  def tool_definitions do
    [
      %{
        "name" => "linear_graphql",
        "description" => "Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth.",
        "inputSchema" => %{
          "type" => "object",
          "required" => ["query"],
          "properties" => %{
            "query" => %{
              "type" => "string",
              "description" => "GraphQL query or mutation document to execute against Linear."
            },
            "variables" => %{
              "type" => "object",
              "description" => "Optional GraphQL variables object."
            }
          }
        }
      },
      %{
        "name" => "linear_create_comment",
        "description" => "Create a Linear issue comment using Symphony's tracker integration. Use this instead of raw GraphQL for agent replies.",
        "inputSchema" => %{
          "type" => "object",
          "required" => ["issue_id", "body"],
          "properties" => %{
            "issue_id" => %{
              "type" => "string",
              "description" => "Linear issue UUID that should receive the comment."
            },
            "body" => %{
              "type" => "string",
              "description" => "Markdown comment body."
            }
          }
        }
      },
      %{
        "name" => "linear_update_comment",
        "description" => "Update an existing Linear comment using Symphony's tracker integration.",
        "inputSchema" => %{
          "type" => "object",
          "required" => ["comment_id", "body"],
          "properties" => %{
            "comment_id" => %{
              "type" => "string",
              "description" => "Linear comment UUID to update."
            },
            "body" => %{
              "type" => "string",
              "description" => "Full Markdown comment body."
            }
          }
        }
      }
    ]
  end

  @spec execute(String.t(), map(), keyword()) :: {:ok, String.t()} | {:error, String.t()}
  def execute(tool_name, arguments, opts \\ []) do
    case tool_name do
      "linear_graphql" -> execute_graphql(arguments, opts)
      "linear_create_comment" -> execute_create_comment(arguments, opts)
      "linear_update_comment" -> execute_update_comment(arguments, opts)
      other -> {:error, "Unknown tool: #{other}"}
    end
  end

  defp execute_graphql(arguments, opts) do
    query = Map.get(arguments, "query", "")
    variables = Map.get(arguments, "variables", %{})

    if String.trim(query) == "" do
      {:error, "`linear_graphql` requires a non-empty `query` string."}
    else
      body = Jason.encode!(%{"query" => query, "variables" => variables})
      post_graphql(body, opts)
    end
  end

  defp execute_create_comment(arguments, opts) do
    issue_id = Map.get(arguments, "issue_id", "")
    body = Map.get(arguments, "body", "")

    cond do
      String.trim(issue_id) == "" ->
        {:error, "`linear_create_comment` requires a non-empty `issue_id` string."}

      String.trim(body) == "" ->
        {:error, "Comment tools require a non-empty `body` string."}

      true ->
        do_create_comment(issue_id, body, opts)
    end
  end

  defp do_create_comment(issue_id, body, opts) do
    tagged_body = "#{@agent_reply_tag}\n#{body}"

    mutation = """
    mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment { id }
      }
    }
    """

    variables = %{"input" => %{"issueId" => issue_id, "body" => tagged_body}}
    graphql_body = Jason.encode!(%{"query" => mutation, "variables" => variables})

    case post_graphql(graphql_body, opts) do
      {:ok, response_text} -> parse_create_comment_response(response_text, issue_id)
      error -> error
    end
  end

  defp parse_create_comment_response(response_text, issue_id) do
    case Jason.decode(response_text) do
      {:ok, %{"data" => %{"commentCreate" => %{"success" => true, "comment" => %{"id" => comment_id}}}}} ->
        {:ok, Jason.encode!(%{"commentId" => comment_id, "issueId" => issue_id, "success" => true})}

      _ ->
        {:ok, response_text}
    end
  end

  defp execute_update_comment(arguments, opts) do
    comment_id = Map.get(arguments, "comment_id", "")
    body = Map.get(arguments, "body", "")

    cond do
      String.trim(comment_id) == "" ->
        {:error, "`linear_update_comment` requires a non-empty `comment_id` string."}

      String.trim(body) == "" ->
        {:error, "Comment tools require a non-empty `body` string."}

      true ->
        do_update_comment(comment_id, body, opts)
    end
  end

  defp do_update_comment(comment_id, body, opts) do
    mutation = """
    mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
      commentUpdate(id: $id, input: $input) {
        success
        comment { id }
      }
    }
    """

    variables = %{"id" => comment_id, "input" => %{"body" => body}}
    graphql_body = Jason.encode!(%{"query" => mutation, "variables" => variables})

    case post_graphql(graphql_body, opts) do
      {:ok, response_text} -> parse_update_comment_response(response_text, comment_id)
      error -> error
    end
  end

  defp parse_update_comment_response(response_text, comment_id) do
    case Jason.decode(response_text) do
      {:ok, %{"data" => %{"commentUpdate" => %{"success" => true}}}} ->
        {:ok, Jason.encode!(%{"commentId" => comment_id, "success" => true})}

      _ ->
        {:ok, response_text}
    end
  end

  defp post_graphql(body, opts) do
    http_client = Keyword.get(opts, :http_client, &default_http_client/2)
    endpoint = Keyword.get(opts, :endpoint, System.get_env("LINEAR_ENDPOINT") || @default_endpoint)

    case resolve_token(opts) do
      {token, token_type} ->
        http_client.(endpoint, %{body: body, token: token, token_type: token_type})

      :none ->
        {:error, "Linear auth not configured. Set LINEAR_OAUTH_TOKEN or LINEAR_API_KEY."}
    end
  end

  defp resolve_token(opts) do
    oauth_token = Keyword.get(opts, :oauth_token, System.get_env("LINEAR_OAUTH_TOKEN"))

    if is_binary(oauth_token) and oauth_token != "" do
      {oauth_token, :bearer}
    else
      api_key = Keyword.get(opts, :api_key, System.get_env("LINEAR_API_KEY"))

      if is_binary(api_key) and api_key != "" do
        {api_key, :api_key}
      else
        :none
      end
    end
  end

  defp default_http_client(endpoint, %{body: body, token: token, token_type: token_type}) do
    :ok = ensure_httpc_started()

    auth_value =
      case token_type do
        :bearer -> "Bearer #{token}"
        :api_key -> token
      end

    headers = [
      {~c"authorization", String.to_charlist(auth_value)},
      {~c"content-type", ~c"application/json"}
    ]

    request = {String.to_charlist(endpoint), headers, ~c"application/json", body}

    case :httpc.request(:post, request, [{:timeout, 30_000}], []) do
      {:ok, {{_, status, _}, _headers, response_body}} when status in 200..299 ->
        {:ok, List.to_string(response_body)}

      {:ok, {{_, status, _}, _headers, _response_body}} ->
        {:error, "Linear API returned HTTP #{status}."}

      {:error, reason} ->
        {:error, "Linear API request failed: #{inspect(reason)}"}
    end
  end

  defp ensure_httpc_started do
    case :inets.start() do
      :ok -> :ok
      {:error, {:already_started, :inets}} -> :ok
    end

    case :ssl.start() do
      :ok -> :ok
      {:error, {:already_started, :ssl}} -> :ok
    end

    :ok
  end
end
