defmodule SymphonyElixir.Linear.Client do
  @moduledoc """
  Thin Linear GraphQL client for polling candidate issues.
  """

  require Logger
  alias SymphonyElixir.{Config, Linear.Auth, Linear.Comment, Linear.Issue}

  @issue_page_size 50
  @max_error_body_log_bytes 1_000
  @rate_limit_max_retries 3
  @rate_limit_base_delay_ms 2_000

  @comment_page_size 50

  @query """
  query SymphonyLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $commentFirst: Int!, $after: String) {
    issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        description
        priority
        state {
          name
        }
        branchName
        url
        assignee {
          id
        }
        labels {
          nodes {
            name
          }
        }
        comments(first: $commentFirst) {
          nodes {
            id
            body
            user {
              id
              name
            }
            createdAt
          }
        }
        inverseRelations(first: $relationFirst) {
          nodes {
            type
            issue {
              id
              identifier
              state {
                name
              }
            }
          }
        }
        createdAt
        updatedAt
        parent {
          id
          identifier
          title
          state {
            name
          }
        }
        children {
          nodes {
            id
            identifier
            title
            state {
              name
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
  """

  @query_by_label """
  query SymphonyLinearPollByLabel($labelName: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $commentFirst: Int!, $after: String) {
    issues(filter: {labels: {some: {name: {eq: $labelName}}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        description
        priority
        state {
          name
        }
        branchName
        url
        assignee {
          id
        }
        labels {
          nodes {
            name
          }
        }
        comments(first: $commentFirst) {
          nodes {
            id
            body
            user {
              id
              name
            }
            createdAt
          }
        }
        inverseRelations(first: $relationFirst) {
          nodes {
            type
            issue {
              id
              identifier
              state {
                name
              }
            }
          }
        }
        createdAt
        updatedAt
        parent {
          id
          identifier
          title
          state {
            name
          }
        }
        children {
          nodes {
            id
            identifier
            title
            state {
              name
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
  """

  @query_by_label_and_project """
  query SymphonyLinearPollByLabelAndProject($labelName: String!, $projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $commentFirst: Int!, $after: String) {
    issues(filter: {labels: {some: {name: {eq: $labelName}}}, project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        description
        priority
        state {
          name
        }
        branchName
        url
        assignee {
          id
        }
        labels {
          nodes {
            name
          }
        }
        comments(first: $commentFirst) {
          nodes {
            id
            body
            user {
              id
              name
            }
            createdAt
          }
        }
        inverseRelations(first: $relationFirst) {
          nodes {
            type
            issue {
              id
              identifier
              state {
                name
              }
            }
          }
        }
        createdAt
        updatedAt
        parent {
          id
          identifier
          title
          state {
            name
          }
        }
        children {
          nodes {
            id
            identifier
            title
            state {
              name
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
  """

  @query_by_ids """
  query SymphonyLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!, $commentFirst: Int!) {
    issues(filter: {id: {in: $ids}}, first: $first) {
      nodes {
        id
        identifier
        title
        description
        priority
        state {
          name
        }
        branchName
        url
        assignee {
          id
        }
        labels {
          nodes {
            name
          }
        }
        comments(first: $commentFirst) {
          nodes {
            id
            body
            user {
              id
              name
            }
            createdAt
          }
        }
        inverseRelations(first: $relationFirst) {
          nodes {
            type
            issue {
              id
              identifier
              state {
                name
              }
            }
          }
        }
        createdAt
        updatedAt
        parent {
          id
          identifier
          title
          state {
            name
          }
        }
        children {
          nodes {
            id
            identifier
            title
            state {
              name
            }
          }
        }
        project {
          slugId
        }
      }
    }
  }
  """

  @viewer_query """
  query SymphonyLinearViewer {
    viewer {
      id
    }
  }
  """

  @org_query """
  query SymphonyLinearOrg {
    organization {
      id
      name
    }
  }
  """

  @spec fetch_organization_id() :: {:ok, String.t()} | {:error, term()}
  def fetch_organization_id do
    case graphql(@org_query, %{}) do
      {:ok, %{"data" => %{"organization" => %{"id" => id}}}} when is_binary(id) ->
        {:ok, id}

      {:ok, _body} ->
        {:error, :no_organization}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec fetch_candidate_issues() :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_candidate_issues do
    tracker = Config.settings!().tracker

    with :ok <- validate_tracker_api_key(tracker),
         {:ok, assignee_filter} <- routing_assignee_filter() do
      fetch_candidate_issues_for_tracker(tracker, assignee_filter)
    end
  end

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_states(state_names) when is_list(state_names) do
    normalized_states = Enum.map(state_names, &to_string/1) |> Enum.uniq()

    if normalized_states == [] do
      {:ok, []}
    else
      tracker = Config.settings!().tracker
      project_slug = tracker.project_slug

      cond do
        not Auth.has_auth?() ->
          {:error, :missing_linear_api_token}

        is_nil(project_slug) ->
          {:error, :missing_linear_project_slug}

        true ->
          do_fetch_by_states(extract_slug_id(project_slug), normalized_states, nil)
      end
    end
  end

  @spec fetch_issue_states_by_ids([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issue_states_by_ids(issue_ids) when is_list(issue_ids) do
    ids = Enum.uniq(issue_ids)

    case ids do
      [] ->
        {:ok, []}

      ids ->
        with {:ok, assignee_filter} <- routing_assignee_filter() do
          do_fetch_issue_states(ids, assignee_filter)
        end
    end
  end

  @spec fetch_issue_comments(String.t()) :: {:ok, [Comment.t()]} | {:error, term()}
  def fetch_issue_comments(issue_id) when is_binary(issue_id) do
    case fetch_issue_states_by_ids([issue_id]) do
      {:ok, [%Issue{comments: comments} | _]} -> {:ok, comments}
      {:ok, []} -> {:ok, []}
      {:error, reason} -> {:error, reason}
    end
  end

  @spec graphql(String.t(), map(), keyword()) :: {:ok, map()} | {:error, term()}
  def graphql(query, variables \\ %{}, opts \\ [])
      when is_binary(query) and is_map(variables) and is_list(opts) do
    payload = build_graphql_payload(query, variables, Keyword.get(opts, :operation_name))
    request_fun = Keyword.get(opts, :request_fun, &post_graphql_request/2)
    graphql_with_retry(payload, request_fun, 0)
  end

  defp graphql_with_retry(payload, request_fun, attempt) do
    with {:ok, headers} <- graphql_headers(),
         {:ok, %{status: 200, body: body}} <- request_fun.(payload, headers) do
      {:ok, body}
    else
      {:ok, %{status: 400, body: body} = response} when is_map(body) ->
        if rate_limited_response?(body) and attempt < @rate_limit_max_retries do
          delay = rate_limit_retry_delay(response, attempt)

          Logger.warning(
            "Linear API rate limited, retrying in #{delay}ms (attempt #{attempt + 1}/#{@rate_limit_max_retries})" <>
              linear_error_context(payload, response)
          )

          Process.sleep(delay)
          graphql_with_retry(payload, request_fun, attempt + 1)
        else
          Logger.error(
            "Linear GraphQL request failed status=400" <>
              linear_error_context(payload, response)
          )

          {:error, {:linear_api_status, 400}}
        end

      {:ok, response} ->
        Logger.error(
          "Linear GraphQL request failed status=#{response.status}" <>
            linear_error_context(payload, response)
        )

        {:error, {:linear_api_status, response.status}}

      {:error, reason} ->
        Logger.error("Linear GraphQL request failed: #{inspect(reason)}")
        {:error, {:linear_api_request, reason}}
    end
  end

  defp rate_limited_response?(%{"errors" => errors}) when is_list(errors) do
    Enum.any?(errors, fn
      %{"extensions" => %{"code" => "RATELIMITED"}} -> true
      _ -> false
    end)
  end

  defp rate_limited_response?(_body), do: false

  defp rate_limit_retry_delay(response, attempt) do
    reset_ms = get_in_headers(response, "x-ratelimit-requests-reset")
    backoff = @rate_limit_base_delay_ms * Integer.pow(2, attempt)

    case reset_ms do
      ms when is_integer(ms) ->
        wait = max(ms - System.system_time(:millisecond), 1_000)
        min(wait, 60_000)

      _ ->
        backoff
    end
  end

  defp get_in_headers(%{headers: headers}, name) when is_map(headers) do
    case Map.get(headers, name) do
      [value | _] -> parse_integer(value)
      value when is_binary(value) -> parse_integer(value)
      _ -> nil
    end
  end

  defp get_in_headers(%{headers: headers}, name) when is_list(headers) do
    Enum.find_value(headers, fn
      {^name, value} -> parse_integer(value)
      _ -> nil
    end)
  end

  defp get_in_headers(_response, _name), do: nil

  defp parse_integer(value) when is_binary(value) do
    case Integer.parse(value) do
      {int, ""} -> int
      _ -> nil
    end
  end

  defp parse_integer(_value), do: nil

  @doc false
  @spec normalize_issue_for_test(map()) :: Issue.t() | nil
  def normalize_issue_for_test(issue) when is_map(issue) do
    normalize_issue(issue, nil)
  end

  @doc false
  @spec normalize_issue_for_test(map(), String.t() | nil) :: Issue.t() | nil
  def normalize_issue_for_test(issue, assignee) when is_map(issue) do
    assignee_filter =
      case assignee do
        value when is_binary(value) ->
          case build_assignee_filter(value) do
            {:ok, filter} -> filter
            {:error, _reason} -> nil
          end

        _ ->
          nil
      end

    normalize_issue(issue, assignee_filter)
  end

  @doc false
  @spec next_page_cursor_for_test(map()) :: {:ok, String.t()} | :done | {:error, term()}
  def next_page_cursor_for_test(page_info) when is_map(page_info), do: next_page_cursor(page_info)

  @doc false
  @spec merge_issue_pages_for_test([[Issue.t()]]) :: [Issue.t()]
  def merge_issue_pages_for_test(issue_pages) when is_list(issue_pages) do
    issue_pages
    |> Enum.reduce([], &prepend_page_issues/2)
    |> finalize_paginated_issues()
  end

  @doc false
  @spec fetch_issue_states_by_ids_for_test([String.t()], (String.t(), map() -> {:ok, map()} | {:error, term()})) ::
          {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issue_states_by_ids_for_test(issue_ids, graphql_fun)
      when is_list(issue_ids) and is_function(graphql_fun, 2) do
    ids = Enum.uniq(issue_ids)

    case ids do
      [] ->
        {:ok, []}

      ids ->
        do_fetch_issue_states(ids, nil, graphql_fun)
    end
  end

  @doc false
  @spec fetch_candidate_issues_for_test((String.t(), map() -> {:ok, map()} | {:error, term()})) ::
          {:ok, [Issue.t()]} | {:error, term()}
  def fetch_candidate_issues_for_test(graphql_fun) when is_function(graphql_fun, 2) do
    tracker = Config.settings!().tracker

    with {:ok, assignee_filter} <- routing_assignee_filter_for_test(graphql_fun) do
      fetch_candidate_issues_for_tracker_with(tracker, assignee_filter, graphql_fun)
    end
  end

  defp fetch_candidate_issues_for_tracker(tracker, assignee_filter) do
    case tracker.filter_by do
      "label" ->
        fetch_candidate_issues_by_label(tracker, assignee_filter)

      _ ->
        fetch_candidate_issues_by_project(tracker, assignee_filter)
    end
  end

  defp fetch_candidate_issues_for_tracker_with(tracker, assignee_filter, graphql_fun) do
    case tracker.filter_by do
      "label" ->
        fetch_candidate_issues_by_label_with(tracker, assignee_filter, graphql_fun)

      _ ->
        do_fetch_by_states_with(
          extract_slug_id(tracker.project_slug),
          tracker.active_states,
          assignee_filter,
          graphql_fun
        )
    end
  end

  defp fetch_candidate_issues_by_label(tracker, assignee_filter) do
    case {tracker.label_name, extract_optional_slug_id(tracker.project_slug)} do
      {label_name, slug} when is_binary(label_name) and is_binary(slug) ->
        do_fetch_by_label_and_project(label_name, slug, tracker.active_states, assignee_filter)

      {label_name, nil} when is_binary(label_name) ->
        do_fetch_by_label(label_name, tracker.active_states, assignee_filter)

      _ ->
        {:error, :missing_linear_label_name}
    end
  end

  defp fetch_candidate_issues_by_label_with(tracker, assignee_filter, graphql_fun) do
    case {tracker.label_name, extract_optional_slug_id(tracker.project_slug)} do
      {label_name, slug} when is_binary(label_name) and is_binary(slug) ->
        do_fetch_by_label_and_project_with(
          label_name,
          slug,
          tracker.active_states,
          assignee_filter,
          graphql_fun
        )

      {label_name, nil} when is_binary(label_name) ->
        do_fetch_by_label_with(label_name, tracker.active_states, assignee_filter, graphql_fun)

      _ ->
        {:error, :missing_linear_label_name}
    end
  end

  defp fetch_candidate_issues_by_project(tracker, assignee_filter) do
    case tracker.project_slug do
      project_slug when is_binary(project_slug) ->
        do_fetch_by_states(extract_slug_id(project_slug), tracker.active_states, assignee_filter)

      _ ->
        {:error, :missing_linear_project_slug}
    end
  end

  defp validate_tracker_api_key(%{api_key: api_key}) when is_binary(api_key), do: :ok

  defp validate_tracker_api_key(_tracker) do
    if Auth.has_oauth_token?(), do: :ok, else: {:error, :missing_linear_api_token}
  end

  defp do_fetch_by_states(project_slug, state_names, assignee_filter) do
    do_fetch_by_states_page(project_slug, state_names, assignee_filter, nil, [])
  end

  defp do_fetch_by_states_with(project_slug, state_names, assignee_filter, graphql_fun) do
    do_fetch_by_states_page(project_slug, state_names, assignee_filter, nil, [], graphql_fun)
  end

  defp do_fetch_by_label(label_name, state_names, assignee_filter) do
    do_fetch_by_label_page(label_name, state_names, assignee_filter, nil, [])
  end

  defp do_fetch_by_label_with(label_name, state_names, assignee_filter, graphql_fun) do
    do_fetch_by_label_page(label_name, state_names, assignee_filter, nil, [], graphql_fun)
  end

  defp do_fetch_by_label_and_project(label_name, project_slug, state_names, assignee_filter) do
    do_fetch_by_label_and_project_page(label_name, project_slug, state_names, assignee_filter, nil, [])
  end

  defp do_fetch_by_label_and_project_with(label_name, project_slug, state_names, assignee_filter, graphql_fun) do
    do_fetch_by_label_and_project_page(label_name, project_slug, state_names, assignee_filter, nil, [], graphql_fun)
  end

  defp do_fetch_by_states_page(project_slug, state_names, assignee_filter, after_cursor, acc_issues) do
    do_fetch_by_states_page(project_slug, state_names, assignee_filter, after_cursor, acc_issues, &graphql/2)
  end

  defp do_fetch_by_states_page(project_slug, state_names, assignee_filter, after_cursor, acc_issues, graphql_fun)
       when is_function(graphql_fun, 2) do
    with {:ok, body} <-
           graphql_fun.(@query, %{
             projectSlug: project_slug,
             stateNames: state_names,
             first: @issue_page_size,
             relationFirst: @issue_page_size,
             commentFirst: @comment_page_size,
             after: after_cursor
           }),
         {:ok, issues, page_info} <- decode_linear_page_response(body, assignee_filter) do
      updated_acc = prepend_page_issues(issues, acc_issues)

      case next_page_cursor(page_info) do
        {:ok, next_cursor} ->
          do_fetch_by_states_page(project_slug, state_names, assignee_filter, next_cursor, updated_acc, graphql_fun)

        :done ->
          {:ok, finalize_paginated_issues(updated_acc)}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defp do_fetch_by_label_page(label_name, state_names, assignee_filter, after_cursor, acc_issues) do
    do_fetch_by_label_page(label_name, state_names, assignee_filter, after_cursor, acc_issues, &graphql/2)
  end

  defp do_fetch_by_label_page(label_name, state_names, assignee_filter, after_cursor, acc_issues, graphql_fun)
       when is_function(graphql_fun, 2) do
    with {:ok, body} <-
           graphql_fun.(@query_by_label, %{
             labelName: label_name,
             stateNames: state_names,
             first: @issue_page_size,
             relationFirst: @issue_page_size,
             commentFirst: @comment_page_size,
             after: after_cursor
           }),
         {:ok, issues, page_info} <- decode_linear_page_response(body, assignee_filter) do
      updated_acc = prepend_page_issues(issues, acc_issues)

      case next_page_cursor(page_info) do
        {:ok, next_cursor} ->
          do_fetch_by_label_page(label_name, state_names, assignee_filter, next_cursor, updated_acc, graphql_fun)

        :done ->
          {:ok, finalize_paginated_issues(updated_acc)}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defp do_fetch_by_label_and_project_page(
         label_name,
         project_slug,
         state_names,
         assignee_filter,
         after_cursor,
         acc_issues
       ) do
    do_fetch_by_label_and_project_page(
      label_name,
      project_slug,
      state_names,
      assignee_filter,
      after_cursor,
      acc_issues,
      &graphql/2
    )
  end

  defp do_fetch_by_label_and_project_page(
         label_name,
         project_slug,
         state_names,
         assignee_filter,
         after_cursor,
         acc_issues,
         graphql_fun
       )
       when is_function(graphql_fun, 2) do
    with {:ok, body} <-
           graphql_fun.(@query_by_label_and_project, %{
             labelName: label_name,
             projectSlug: project_slug,
             stateNames: state_names,
             first: @issue_page_size,
             relationFirst: @issue_page_size,
             commentFirst: @comment_page_size,
             after: after_cursor
           }),
         {:ok, issues, page_info} <- decode_linear_page_response(body, assignee_filter) do
      updated_acc = prepend_page_issues(issues, acc_issues)

      case next_page_cursor(page_info) do
        {:ok, next_cursor} ->
          do_fetch_by_label_and_project_page(
            label_name,
            project_slug,
            state_names,
            assignee_filter,
            next_cursor,
            updated_acc,
            graphql_fun
          )

        :done ->
          {:ok, finalize_paginated_issues(updated_acc)}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defp prepend_page_issues(issues, acc_issues) when is_list(issues) and is_list(acc_issues) do
    Enum.reverse(issues, acc_issues)
  end

  defp finalize_paginated_issues(acc_issues) when is_list(acc_issues), do: Enum.reverse(acc_issues)

  defp do_fetch_issue_states(ids, assignee_filter) do
    do_fetch_issue_states(ids, assignee_filter, &graphql/2)
  end

  defp do_fetch_issue_states(ids, assignee_filter, graphql_fun)
       when is_list(ids) and is_function(graphql_fun, 2) do
    issue_order_index = issue_order_index(ids)
    do_fetch_issue_states_page(ids, assignee_filter, graphql_fun, [], issue_order_index)
  end

  defp do_fetch_issue_states_page([], _assignee_filter, _graphql_fun, acc_issues, issue_order_index) do
    acc_issues
    |> finalize_paginated_issues()
    |> sort_issues_by_requested_ids(issue_order_index)
    |> then(&{:ok, &1})
  end

  defp do_fetch_issue_states_page(ids, assignee_filter, graphql_fun, acc_issues, issue_order_index) do
    {batch_ids, rest_ids} = Enum.split(ids, @issue_page_size)

    case graphql_fun.(@query_by_ids, %{
           ids: batch_ids,
           first: length(batch_ids),
           relationFirst: @issue_page_size,
           commentFirst: @comment_page_size
         }) do
      {:ok, body} ->
        with {:ok, issues} <- decode_linear_response(body, assignee_filter) do
          updated_acc = prepend_page_issues(issues, acc_issues)
          do_fetch_issue_states_page(rest_ids, assignee_filter, graphql_fun, updated_acc, issue_order_index)
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp issue_order_index(ids) when is_list(ids) do
    ids
    |> Enum.with_index()
    |> Map.new()
  end

  defp sort_issues_by_requested_ids(issues, issue_order_index)
       when is_list(issues) and is_map(issue_order_index) do
    fallback_index = map_size(issue_order_index)

    Enum.sort_by(issues, fn
      %Issue{id: issue_id} -> Map.get(issue_order_index, issue_id, fallback_index)
      _ -> fallback_index
    end)
  end

  defp build_graphql_payload(query, variables, operation_name) do
    %{
      "query" => query,
      "variables" => variables
    }
    |> maybe_put_operation_name(operation_name)
  end

  defp maybe_put_operation_name(payload, operation_name) when is_binary(operation_name) do
    trimmed = String.trim(operation_name)

    if trimmed == "" do
      payload
    else
      Map.put(payload, "operationName", trimmed)
    end
  end

  defp maybe_put_operation_name(payload, _operation_name), do: payload

  defp linear_error_context(payload, response) when is_map(payload) do
    operation_name =
      case Map.get(payload, "operationName") do
        name when is_binary(name) and name != "" -> " operation=#{name}"
        _ -> ""
      end

    body =
      response
      |> Map.get(:body)
      |> summarize_error_body()

    operation_name <> " body=" <> body
  end

  defp summarize_error_body(body) when is_binary(body) do
    body
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
    |> truncate_error_body()
    |> inspect()
  end

  defp summarize_error_body(body) do
    body
    |> inspect(limit: 20, printable_limit: @max_error_body_log_bytes)
    |> truncate_error_body()
  end

  defp truncate_error_body(body) when is_binary(body) do
    if byte_size(body) > @max_error_body_log_bytes do
      binary_part(body, 0, @max_error_body_log_bytes) <> "...<truncated>"
    else
      body
    end
  end

  defp graphql_headers do
    case Auth.resolve_auth_header() do
      {:ok, auth_header} ->
        {:ok, [auth_header, {"Content-Type", "application/json"}]}

      {:error, _} ->
        {:error, :missing_linear_api_token}
    end
  end

  defp post_graphql_request(payload, headers) do
    Req.post(Config.settings!().tracker.endpoint,
      headers: headers,
      json: payload,
      connect_options: [timeout: 30_000]
    )
  end

  defp decode_linear_response(%{"data" => %{"issues" => %{"nodes" => nodes}}}, assignee_filter) do
    issues =
      nodes
      |> Enum.map(&normalize_issue(&1, assignee_filter))
      |> Enum.reject(&is_nil(&1))

    {:ok, issues}
  end

  defp decode_linear_response(%{"errors" => errors}, _assignee_filter) do
    {:error, {:linear_graphql_errors, errors}}
  end

  defp decode_linear_response(_unknown, _assignee_filter) do
    {:error, :linear_unknown_payload}
  end

  defp decode_linear_page_response(
         %{
           "data" => %{
             "issues" => %{
               "nodes" => nodes,
               "pageInfo" => %{"hasNextPage" => has_next_page, "endCursor" => end_cursor}
             }
           }
         },
         assignee_filter
       ) do
    with {:ok, issues} <- decode_linear_response(%{"data" => %{"issues" => %{"nodes" => nodes}}}, assignee_filter) do
      {:ok, issues, %{has_next_page: has_next_page == true, end_cursor: end_cursor}}
    end
  end

  defp decode_linear_page_response(response, assignee_filter), do: decode_linear_response(response, assignee_filter)

  defp next_page_cursor(%{has_next_page: true, end_cursor: end_cursor})
       when is_binary(end_cursor) and byte_size(end_cursor) > 0 do
    {:ok, end_cursor}
  end

  defp next_page_cursor(%{has_next_page: true}), do: {:error, :linear_missing_end_cursor}
  defp next_page_cursor(_), do: :done

  defp normalize_issue(issue, assignee_filter) when is_map(issue) do
    assignee = issue["assignee"]
    comments = extract_comments(issue)
    live_workpad_comment = Comment.live_workpad_comment(comments)

    %Issue{
      id: issue["id"],
      identifier: issue["identifier"],
      title: issue["title"],
      description: issue["description"],
      priority: parse_priority(issue["priority"]),
      state: get_in(issue, ["state", "name"]),
      branch_name: issue["branchName"],
      url: issue["url"],
      assignee_id: assignee_field(assignee, "id"),
      live_workpad_comment_id: live_workpad_comment && live_workpad_comment.id,
      workpad_comment_count: Comment.workpad_comment_count(comments),
      blocked_by: extract_blockers(issue),
      parent_issue: extract_parent(issue),
      child_issues: extract_children(issue),
      labels: extract_labels(issue),
      comments: comments,
      assigned_to_worker: assigned_to_worker?(assignee, assignee_filter),
      project_slug_id: get_in(issue, ["project", "slugId"]),
      created_at: parse_datetime(issue["createdAt"]),
      updated_at: parse_datetime(issue["updatedAt"])
    }
  end

  defp normalize_issue(_issue, _assignee_filter), do: nil

  defp assignee_field(%{} = assignee, field) when is_binary(field), do: assignee[field]
  defp assignee_field(_assignee, _field), do: nil

  defp assigned_to_worker?(_assignee, nil), do: true

  defp assigned_to_worker?(%{} = assignee, %{match_values: match_values})
       when is_struct(match_values, MapSet) do
    assignee
    |> assignee_id()
    |> then(fn
      nil -> false
      assignee_id -> MapSet.member?(match_values, assignee_id)
    end)
  end

  defp assigned_to_worker?(_assignee, _assignee_filter), do: false

  defp assignee_id(%{} = assignee), do: normalize_assignee_match_value(assignee["id"])

  defp routing_assignee_filter do
    case Config.settings!().tracker.assignee do
      nil ->
        {:ok, nil}

      assignee ->
        build_assignee_filter(assignee)
    end
  end

  defp routing_assignee_filter_for_test(graphql_fun) when is_function(graphql_fun, 2) do
    case Config.settings!().tracker.assignee do
      nil ->
        {:ok, nil}

      assignee ->
        build_assignee_filter_for_test(assignee, graphql_fun)
    end
  end

  defp build_assignee_filter(assignee) when is_binary(assignee) do
    case normalize_assignee_match_value(assignee) do
      nil ->
        {:ok, nil}

      "me" ->
        resolve_viewer_assignee_filter()

      normalized ->
        {:ok, %{configured_assignee: assignee, match_values: MapSet.new([normalized])}}
    end
  end

  defp resolve_viewer_assignee_filter do
    case graphql(@viewer_query, %{}) do
      {:ok, %{"data" => %{"viewer" => viewer}}} when is_map(viewer) ->
        case assignee_id(viewer) do
          nil ->
            {:error, :missing_linear_viewer_identity}

          viewer_id ->
            {:ok, %{configured_assignee: "me", match_values: MapSet.new([viewer_id])}}
        end

      {:ok, _body} ->
        {:error, :missing_linear_viewer_identity}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp build_assignee_filter_for_test(assignee, graphql_fun) when is_binary(assignee) do
    case normalize_assignee_match_value(assignee) do
      nil ->
        {:ok, nil}

      "me" ->
        resolve_viewer_assignee_filter_for_test(graphql_fun)

      normalized ->
        {:ok, %{configured_assignee: assignee, match_values: MapSet.new([normalized])}}
    end
  end

  defp resolve_viewer_assignee_filter_for_test(graphql_fun) when is_function(graphql_fun, 2) do
    case graphql_fun.(@viewer_query, %{}) do
      {:ok, %{"data" => %{"viewer" => viewer}}} when is_map(viewer) ->
        case assignee_id(viewer) do
          nil ->
            {:error, :missing_linear_viewer_identity}

          viewer_id ->
            {:ok, %{configured_assignee: "me", match_values: MapSet.new([viewer_id])}}
        end

      {:ok, _body} ->
        {:error, :missing_linear_viewer_identity}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp normalize_assignee_match_value(value) when is_binary(value) do
    case value |> String.trim() do
      "" -> nil
      normalized -> normalized
    end
  end

  defp normalize_assignee_match_value(_value), do: nil

  defp extract_comments(%{"comments" => %{"nodes" => comments}}) when is_list(comments) do
    Enum.map(comments, fn comment ->
      %Comment{
        id: comment["id"],
        body: comment["body"],
        author: get_in(comment, ["user", "name"]),
        author_id: get_in(comment, ["user", "id"]),
        created_at: comment["createdAt"]
      }
    end)
  end

  defp extract_comments(_), do: []

  defp extract_labels(%{"labels" => %{"nodes" => labels}}) when is_list(labels) do
    labels
    |> Enum.map(& &1["name"])
    |> Enum.reject(&is_nil/1)
    |> Enum.map(&String.downcase/1)
  end

  defp extract_labels(_), do: []

  defp extract_blockers(%{"inverseRelations" => %{"nodes" => inverse_relations}})
       when is_list(inverse_relations) do
    inverse_relations
    |> Enum.flat_map(fn
      %{"type" => relation_type, "issue" => blocker_issue}
      when is_binary(relation_type) and is_map(blocker_issue) ->
        if String.downcase(String.trim(relation_type)) == "blocks" do
          [
            %{
              id: blocker_issue["id"],
              identifier: blocker_issue["identifier"],
              state: get_in(blocker_issue, ["state", "name"])
            }
          ]
        else
          []
        end

      _ ->
        []
    end)
  end

  defp extract_blockers(_), do: []

  defp extract_parent(%{"parent" => %{"id" => id} = parent}) when is_binary(id) do
    %{
      id: id,
      identifier: parent["identifier"],
      title: parent["title"],
      state: get_in(parent, ["state", "name"])
    }
  end

  defp extract_parent(_), do: nil

  defp extract_children(%{"children" => %{"nodes" => children}}) when is_list(children) do
    Enum.map(children, fn child ->
      %{
        id: child["id"],
        identifier: child["identifier"],
        title: child["title"],
        state: get_in(child, ["state", "name"])
      }
    end)
  end

  defp extract_children(_), do: []

  defp parse_datetime(nil), do: nil

  defp parse_datetime(raw) do
    case DateTime.from_iso8601(raw) do
      {:ok, dt, _offset} -> dt
      _ -> nil
    end
  end

  defp parse_priority(priority) when is_integer(priority), do: priority
  defp parse_priority(_priority), do: nil

  # Linear's GraphQL `slugId` filter expects only the hex hash portion
  # of the project slug (e.g. "1b3188ca0747"), not the full URL slug
  # (e.g. "agent-workflow-1b3188ca0747"). Extract the trailing hex segment.
  defp extract_optional_slug_id(nil), do: nil
  defp extract_optional_slug_id(""), do: nil
  defp extract_optional_slug_id(slug) when is_binary(slug), do: extract_slug_id(slug)

  defp extract_slug_id(project_slug) when is_binary(project_slug) do
    case Regex.run(~r/-([0-9a-f]{10,})$/, project_slug) do
      [_, hex_id] -> hex_id
      _ -> project_slug
    end
  end
end
