defmodule SymphonyElixir.Codex.DynamicTool do
  @moduledoc """
  Executes client-side tool calls requested by Codex app-server turns.
  """

  alias SymphonyElixir.{AgentSession, Linear.Client, Linear.Comment, Linear.PlanBuilder, Tracker}

  @linear_graphql_tool "linear_graphql"
  @linear_create_comment_tool "linear_create_comment"
  @linear_update_comment_tool "linear_update_comment"
  @linear_graphql_description """
  Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth.
  """
  @linear_create_comment_description """
  Create a Linear issue comment using Symphony's tracker integration. Use this instead of raw GraphQL for agent replies.
  """
  @linear_update_comment_description """
  Update an existing Linear comment using Symphony's tracker integration.
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
  @linear_create_comment_input_schema %{
    "type" => "object",
    "additionalProperties" => false,
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
  @linear_update_comment_input_schema %{
    "type" => "object",
    "additionalProperties" => false,
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

  @spec execute(String.t() | nil, term(), keyword()) :: map()
  def execute(tool, arguments, opts \\ []) do
    case tool do
      @linear_graphql_tool ->
        execute_linear_graphql(arguments, opts)

      @linear_create_comment_tool ->
        execute_linear_create_comment(arguments, opts)

      @linear_update_comment_tool ->
        execute_linear_update_comment(arguments, opts)

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
        "name" => @linear_graphql_tool,
        "description" => @linear_graphql_description,
        "inputSchema" => @linear_graphql_input_schema
      },
      %{
        "name" => @linear_create_comment_tool,
        "description" => @linear_create_comment_description,
        "inputSchema" => @linear_create_comment_input_schema
      },
      %{
        "name" => @linear_update_comment_tool,
        "description" => @linear_update_comment_description,
        "inputSchema" => @linear_update_comment_input_schema
      }
    ]
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

  defp execute_linear_create_comment(arguments, opts) do
    create_comment = Keyword.get(opts, :tracker_create_comment, &Tracker.create_comment/2)

    with {:ok, issue_id, body} <- normalize_issue_comment_arguments(arguments, :create),
         {:ok, comment_id} <- create_comment.(issue_id, Comment.tag_agent_reply(body)) do
      maybe_sync_workpad_plan(body, issue_id)
      graphql_response(%{"commentId" => comment_id, "issueId" => issue_id, "success" => true})
    else
      {:error, reason} ->
        failure_response(tool_error_payload(reason))
    end
  end

  defp execute_linear_update_comment(arguments, opts) do
    update_comment = Keyword.get(opts, :tracker_update_comment, &Tracker.update_comment/2)

    issue_id = Keyword.get(opts, :issue_id)

    with {:ok, comment_id, body} <- normalize_issue_comment_arguments(arguments, :update),
         :ok <- update_comment.(comment_id, body) do
      if issue_id, do: maybe_sync_workpad_plan(body, issue_id)
      graphql_response(%{"commentId" => comment_id, "success" => true})
    else
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

  defp normalize_issue_comment_arguments(arguments, mode) when is_map(arguments) do
    id_key = if mode == :create, do: "issue_id", else: "comment_id"

    with {:ok, id} <- normalize_required_string(arguments, id_key),
         {:ok, body} <- normalize_required_string(arguments, "body") do
      {:ok, id, body}
    end
  end

  defp normalize_issue_comment_arguments(_arguments, :create), do: {:error, :invalid_create_comment_arguments}
  defp normalize_issue_comment_arguments(_arguments, :update), do: {:error, :invalid_update_comment_arguments}

  defp normalize_required_string(arguments, key) do
    case argument_value(arguments, key) do
      value when is_binary(value) ->
        case String.trim(value) do
          "" -> {:error, {:missing_required_argument, key}}
          trimmed -> {:ok, trimmed}
        end

      _ ->
        {:error, {:missing_required_argument, key}}
    end
  end

  defp argument_value(arguments, "issue_id"), do: Map.get(arguments, "issue_id") || Map.get(arguments, :issue_id)
  defp argument_value(arguments, "comment_id"), do: Map.get(arguments, "comment_id") || Map.get(arguments, :comment_id)
  defp argument_value(arguments, "body"), do: Map.get(arguments, "body") || Map.get(arguments, :body)

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

  defp tool_error_payload(:missing_query) do
    %{
      "error" => %{
        "message" => "`linear_graphql` requires a non-empty `query` string."
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

  defp tool_error_payload(:comment_create_failed) do
    %{
      "error" => %{
        "message" => "Symphony could not create the Linear comment."
      }
    }
  end

  defp tool_error_payload(:comment_update_failed) do
    %{
      "error" => %{
        "message" => "Symphony could not update the Linear comment."
      }
    }
  end

  defp tool_error_payload({:missing_required_argument, "issue_id"}) do
    %{
      "error" => %{
        "message" => "`linear_create_comment` requires a non-empty `issue_id` string."
      }
    }
  end

  defp tool_error_payload({:missing_required_argument, "comment_id"}) do
    %{
      "error" => %{
        "message" => "`linear_update_comment` requires a non-empty `comment_id` string."
      }
    }
  end

  defp tool_error_payload({:missing_required_argument, "body"}) do
    %{
      "error" => %{
        "message" => "Comment tools require a non-empty `body` string."
      }
    }
  end

  defp tool_error_payload(:invalid_create_comment_arguments) do
    %{
      "error" => %{
        "message" => "`linear_create_comment` expects an object with `issue_id` and `body`."
      }
    }
  end

  defp tool_error_payload(:invalid_update_comment_arguments) do
    %{
      "error" => %{
        "message" => "`linear_update_comment` expects an object with `comment_id` and `body`."
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

  defp maybe_sync_workpad_plan(body, issue_id) when is_binary(body) and is_binary(issue_id) do
    case PlanBuilder.parse_workpad_plan(body) do
      [] -> :ok
      steps -> AgentSession.update_plan(issue_id, steps)
    end
  end

  defp maybe_sync_workpad_plan(_body, _issue_id), do: :ok
end
