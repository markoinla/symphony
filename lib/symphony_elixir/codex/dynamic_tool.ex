defmodule SymphonyElixir.Codex.DynamicTool do
  @moduledoc """
  Executes client-side tool calls requested by Codex app-server turns.
  """

  alias SymphonyElixir.Linear.{Client, CommentWatcher, Issue}
  alias SymphonyElixir.Tracker

  @linear_create_issue_comment_tool "linear_create_issue_comment"
  @linear_watch_comments_tool "linear_watch_comments"
  @linear_graphql_tool "linear_graphql"
  @linear_create_issue_comment_mutation """
  mutation SymphonyCreateComment($issueId: String!, $body: String!) {
    commentCreate(input: {issueId: $issueId, body: $body}) {
      success
      comment {
        id
      }
    }
  }
  """
  @linear_create_issue_comment_description """
  Create a new Linear comment on the active issue for this Codex thread.
  """
  @linear_create_issue_comment_input_schema %{
    "type" => "object",
    "additionalProperties" => false,
    "required" => ["body"],
    "properties" => %{
      "body" => %{
        "type" => "string",
        "description" => "Markdown body for the new issue comment."
      }
    }
  }
  @linear_watch_comments_description """
  Fetch the latest non-workpad comments for the active Linear issue in this Codex thread.
  """
  @linear_watch_comments_input_schema %{
    "type" => "object",
    "additionalProperties" => false,
    "properties" => %{}
  }
  @linear_graphql_description """
  Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth.
  """
  @linear_graphql_input_schema %{
    "type" => "object",
    "additionalProperties" => false,
    "required" => ["query"],
    "properties" => %{
      "query" => %{
        "type" => "string",
        "description" => "GraphQL query or mutation document to execute against Linear."
      },
      "variables" => %{
        "type" => ["object", "null"],
        "description" => "Optional GraphQL variables object.",
        "additionalProperties" => true
      }
    }
  }

  @spec execute(String.t() | nil, term(), keyword()) :: map()
  def execute(tool, arguments, opts \\ []) do
    case tool do
      @linear_create_issue_comment_tool ->
        execute_linear_create_issue_comment(arguments, opts)

      @linear_watch_comments_tool ->
        execute_linear_watch_comments(opts)

      @linear_graphql_tool ->
        execute_linear_graphql(arguments, opts)

      other ->
        failure_response(%{
          "error" => %{
            "message" => "Unsupported dynamic tool: #{inspect(other)}.",
            "supportedTools" => supported_tool_names()
          }
        })
    end
  end

  @spec tool_specs() :: [map()]
  def tool_specs do
    [
      %{
        "name" => @linear_create_issue_comment_tool,
        "description" => @linear_create_issue_comment_description,
        "inputSchema" => @linear_create_issue_comment_input_schema
      },
      %{
        "name" => @linear_watch_comments_tool,
        "description" => @linear_watch_comments_description,
        "inputSchema" => @linear_watch_comments_input_schema
      },
      %{
        "name" => @linear_graphql_tool,
        "description" => @linear_graphql_description,
        "inputSchema" => @linear_graphql_input_schema
      }
    ]
  end

  defp execute_linear_create_issue_comment(arguments, opts) do
    linear_client = Keyword.get(opts, :linear_client, &Client.graphql/3)

    with {:ok, issue_id} <- issue_id_from_opts(opts),
         {:ok, body} <- normalize_create_issue_comment_arguments(arguments),
         {:ok, response} <-
           linear_client.(
             @linear_create_issue_comment_mutation,
             %{issueId: issue_id, body: body},
             []
           ),
         true <- get_in(response, ["data", "commentCreate", "success"]) == true,
         comment_id when is_binary(comment_id) <-
           get_in(response, ["data", "commentCreate", "comment", "id"]) do
      dynamic_tool_response(
        true,
        encode_payload(%{
          "issueId" => issue_id,
          "commentId" => comment_id
        })
      )
    else
      false ->
        failure_response(tool_error_payload(:comment_create_failed))

      {:error, reason} ->
        failure_response(tool_error_payload(reason))

      _ ->
        failure_response(tool_error_payload(:comment_create_failed))
    end
  end

  defp execute_linear_graphql(arguments, opts) do
    linear_client = Keyword.get(opts, :linear_client, &Client.graphql/3)

    with {:ok, query, variables} <- normalize_linear_graphql_arguments(arguments),
         {:ok, response} <- linear_client.(query, variables, []) do
      graphql_response(response)
    else
      {:error, reason} ->
        failure_response(tool_error_payload(reason))
    end
  end

  defp execute_linear_watch_comments(opts) do
    issue_state_fetcher = Keyword.get(opts, :issue_state_fetcher, &Tracker.fetch_issue_states_by_ids/1)
    ignored_comment_ids = Keyword.get(opts, :ignored_comment_ids, MapSet.new())

    with {:ok, issue_id} <- issue_id_from_opts(opts),
         {:ok, [%Issue{} = issue | _]} <- issue_state_fetcher.([issue_id]) do
      comments =
        issue.comments
        |> CommentWatcher.actionable_comments(ignored_comment_ids)
        |> Enum.map(&format_comment/1)

      dynamic_tool_response(
        true,
        encode_payload(%{
          "issueId" => issue_id,
          "comments" => comments,
          "totalComments" => length(issue.comments),
          "actionableCommentCount" => length(comments)
        })
      )
    else
      {:ok, []} ->
        failure_response(tool_error_payload(:issue_not_found))

      {:error, reason} ->
        failure_response(tool_error_payload(reason))
    end
  end

  defp normalize_linear_graphql_arguments(arguments) when is_binary(arguments) do
    case String.trim(arguments) do
      "" -> {:error, :missing_query}
      query -> {:ok, query, %{}}
    end
  end

  defp normalize_linear_graphql_arguments(arguments) when is_map(arguments) do
    case normalize_query(arguments) do
      {:ok, query} ->
        case normalize_variables(arguments) do
          {:ok, variables} ->
            {:ok, query, variables}

          {:error, reason} ->
            {:error, reason}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp normalize_linear_graphql_arguments(_arguments), do: {:error, :invalid_arguments}

  defp normalize_create_issue_comment_arguments(arguments) when is_map(arguments) do
    case Map.get(arguments, "body") || Map.get(arguments, :body) do
      body when is_binary(body) ->
        case String.trim(body) do
          "" -> {:error, :missing_comment_body}
          trimmed -> {:ok, trimmed}
        end

      _ ->
        {:error, :missing_comment_body}
    end
  end

  defp normalize_create_issue_comment_arguments(_arguments), do: {:error, :invalid_comment_arguments}

  defp issue_id_from_opts(opts) do
    case Keyword.get(opts, :issue_id) do
      issue_id when is_binary(issue_id) and issue_id != "" -> {:ok, issue_id}
      _ -> {:error, :missing_issue_context}
    end
  end

  defp normalize_query(arguments) do
    case Map.get(arguments, "query") || Map.get(arguments, :query) do
      query when is_binary(query) ->
        case String.trim(query) do
          "" -> {:error, :missing_query}
          trimmed -> {:ok, trimmed}
        end

      _ ->
        {:error, :missing_query}
    end
  end

  defp normalize_variables(arguments) do
    case Map.get(arguments, "variables") || Map.get(arguments, :variables) || %{} do
      variables when is_map(variables) -> {:ok, variables}
      _ -> {:error, :invalid_variables}
    end
  end

  defp graphql_response(response) do
    success =
      case response do
        %{"errors" => errors} when is_list(errors) and errors != [] -> false
        %{errors: errors} when is_list(errors) and errors != [] -> false
        _ -> true
      end

    dynamic_tool_response(success, encode_payload(response))
  end

  defp failure_response(payload) do
    dynamic_tool_response(false, encode_payload(payload))
  end

  defp dynamic_tool_response(success, output) when is_boolean(success) and is_binary(output) do
    %{
      "success" => success,
      "output" => output,
      "contentItems" => [
        %{
          "type" => "inputText",
          "text" => output
        }
      ]
    }
  end

  defp encode_payload(payload) when is_map(payload) or is_list(payload) do
    Jason.encode!(payload, pretty: true)
  end

  defp encode_payload(payload), do: inspect(payload)

  defp format_comment(comment) when is_map(comment) do
    %{
      "id" => Map.get(comment, :id),
      "author" => Map.get(comment, :author),
      "authorId" => Map.get(comment, :author_id),
      "createdAt" => Map.get(comment, :created_at),
      "body" => Map.get(comment, :body)
    }
  end

  defp tool_error_payload(:missing_query) do
    %{
      "error" => %{
        "message" => "`linear_graphql` requires a non-empty `query` string."
      }
    }
  end

  defp tool_error_payload(:missing_comment_body) do
    %{
      "error" => %{
        "message" => "`linear_create_issue_comment` requires a non-empty `body` string."
      }
    }
  end

  defp tool_error_payload(:invalid_comment_arguments) do
    %{
      "error" => %{
        "message" => "`linear_create_issue_comment` expects an object with a non-empty `body` string."
      }
    }
  end

  defp tool_error_payload(:missing_issue_context) do
    %{
      "error" => %{
        "message" => "This tool is only available inside an active issue thread."
      }
    }
  end

  defp tool_error_payload(:issue_not_found) do
    %{
      "error" => %{
        "message" => "The active Linear issue could not be refreshed."
      }
    }
  end

  defp tool_error_payload(:comment_create_failed) do
    %{
      "error" => %{
        "message" => "Linear comment creation failed."
      }
    }
  end

  defp tool_error_payload(:invalid_arguments) do
    %{
      "error" => %{
        "message" => "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`."
      }
    }
  end

  defp tool_error_payload(:invalid_variables) do
    %{
      "error" => %{
        "message" => "`linear_graphql.variables` must be a JSON object when provided."
      }
    }
  end

  defp tool_error_payload(:missing_linear_api_token) do
    %{
      "error" => %{
        "message" => "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`."
      }
    }
  end

  defp tool_error_payload({:linear_api_status, status}) do
    %{
      "error" => %{
        "message" => "Linear GraphQL request failed with HTTP #{status}.",
        "status" => status
      }
    }
  end

  defp tool_error_payload({:linear_api_request, reason}) do
    %{
      "error" => %{
        "message" => "Linear GraphQL request failed before receiving a successful response.",
        "reason" => inspect(reason)
      }
    }
  end

  defp tool_error_payload(reason) do
    %{
      "error" => %{
        "message" => "Linear GraphQL tool execution failed.",
        "reason" => inspect(reason)
      }
    }
  end

  defp supported_tool_names do
    Enum.map(tool_specs(), & &1["name"])
  end
end
