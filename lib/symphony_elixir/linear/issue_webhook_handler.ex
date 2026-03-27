defmodule SymphonyElixir.Linear.IssueWebhookHandler do
  @moduledoc """
  Handles Linear data-change webhook events (Issue create/update, Comment create).

  State-change webhooks are persisted to a durable hint queue in Postgres,
  drained by the orchestrator on a fast interval. Non-state-change updates
  and comments are forwarded directly via GenServer cast for reconciliation.
  """

  require Logger

  alias SymphonyElixir.{Config, Orchestrator, Store}

  @spec dispatch(map()) :: :ok
  def dispatch(%{"type" => "Issue", "action" => action, "data" => data} = payload)
      when action in ["create", "update"] do
    dispatch_issue_event(action, data, payload)
  end

  def dispatch(%{"type" => "Issue", "action" => "remove", "data" => data}) do
    issue_id = Map.get(data, "id", "unknown")
    Logger.debug("Ignoring issue remove webhook issue_id=#{issue_id}")
    log_to_db("Issue", "remove", data, "ignored", "remove events are handled by reconciliation")
    :ok
  end

  def dispatch(%{"type" => "Comment", "action" => action, "data" => data})
      when action in ["create", "update"] do
    dispatch_comment_event(action, data)
  end

  def dispatch(payload) do
    type = Map.get(payload, "type", "unknown")
    action = Map.get(payload, "action", "unknown")
    Logger.debug("Ignoring webhook type=#{type} action=#{action}")
    :ok
  end

  defp dispatch_issue_event(_action, %{"id" => nil}, _payload) do
    Logger.warning("Issue webhook missing data.id, skipping")
    :ok
  end

  defp dispatch_issue_event(action, %{"id" => issue_id} = data, payload) do
    state_name = get_in(data, ["state", "name"])
    identifier = Map.get(data, "identifier", "unknown")

    if issue_matches_configured_project?(data) do
      meta = build_issue_meta(action, data, state_name, identifier)
      log_issue_hint(action, state_name, identifier, payload)

      if state_change_event?(action, payload) do
        # State-change webhook → durable hint queue, drained by orchestrator
        log_to_db("Issue", action, data, "enqueued", nil)
        Store.enqueue_webhook_hint(issue_id, meta)
      else
        # Non-state-change update (labels, assignment) → direct cast for reconciliation
        log_to_db("Issue", action, data, "hint_sent", nil)
        Orchestrator.webhook_issue_hint(issue_id, meta)
      end

      :ok
    else
      Logger.debug("Webhook skipped: #{identifier} project not in configured projects")
      log_to_db("Issue", action, data, "skipped", "project not configured")
      :ok
    end
  end

  defp dispatch_issue_event(_action, _data, _payload) do
    Logger.warning("Issue webhook missing data.id, skipping")
    :ok
  end

  defp dispatch_comment_event(_action, %{"issueId" => nil}) do
    Logger.debug("Comment webhook missing data.issueId, skipping")
    :ok
  end

  defp dispatch_comment_event(action, %{"issueId" => issue_id} = data) do
    Logger.info("Webhook comment hint: issue_id=#{issue_id} action=#{action}")
    log_to_db("Comment", action, data, "hint_sent", nil)

    Orchestrator.webhook_issue_hint(issue_id, %{
      action: "comment",
      source: :webhook
    })
  end

  defp dispatch_comment_event(_action, _data) do
    Logger.debug("Comment webhook missing data.issueId, skipping")
    :ok
  end

  # A state-change event is either: an issue create (new issue appearing),
  # or an issue update where stateId is in updatedFrom (the state changed).
  defp state_change_event?("create", _payload), do: true

  defp state_change_event?("update", payload) do
    case Map.get(payload, "updatedFrom") do
      %{"stateId" => _} -> true
      _ -> false
    end
  end

  defp state_change_event?(_action, _payload), do: false

  defp build_issue_meta(action, data, state_name, identifier) do
    base = %{
      action: action,
      source: :webhook,
      state_name: state_name,
      identifier: identifier
    }

    if terminal_state?(state_name) do
      Map.put(base, :terminal, true)
    else
      base
      |> Map.put(:label_names, extract_label_names(data))
      |> Map.put(:project_id, Map.get(data, "projectId"))
    end
  end

  defp log_issue_hint(action, state_name, identifier, payload) do
    if terminal_state?(state_name) do
      Logger.debug("Webhook hint: issue #{identifier} in terminal state #{state_name}")
    else
      updated_keys = format_updated_keys(payload)

      Logger.info("Webhook issue hint: #{identifier} action=#{action} state=#{state_name}#{updated_keys}")
    end
  end

  defp format_updated_keys(payload) do
    case Map.get(payload, "updatedFrom") do
      updated_from when is_map(updated_from) ->
        " updated_from=#{inspect(Map.keys(updated_from))}"

      _ ->
        ""
    end
  end

  defp extract_label_names(data) do
    case Map.get(data, "labels") do
      labels when is_list(labels) ->
        labels |> Enum.map(&Map.get(&1, "name")) |> Enum.reject(&is_nil/1)

      _ ->
        []
    end
  end

  defp issue_matches_configured_project?(data) do
    case Map.get(data, "projectId") do
      nil ->
        false

      project_id ->
        project_id in Store.list_linear_project_ids()
    end
  end

  defp terminal_state?(nil), do: false

  defp terminal_state?(state_name) when is_binary(state_name) do
    normalized = String.downcase(state_name)

    Config.settings!().tracker.terminal_states
    |> Enum.any?(fn ts -> String.downcase(ts) == normalized end)
  rescue
    _ -> false
  end

  defp log_to_db(webhook_type, action, data, result, detail) do
    Store.log_webhook(%{
      webhook_type: webhook_type,
      action: action,
      issue_id: Map.get(data, "id") || Map.get(data, "issueId"),
      issue_identifier: Map.get(data, "identifier"),
      state_name: get_in(data, ["state", "name"]),
      result: result,
      detail: detail,
      payload_summary: build_payload_summary(webhook_type, data),
      received_at: DateTime.utc_now() |> DateTime.truncate(:second)
    })
  rescue
    e -> Logger.debug("Failed to log webhook to DB: #{Exception.message(e)}")
  end

  defp build_payload_summary("Issue", data) do
    %{
      "project_id" => Map.get(data, "projectId"),
      "team_id" => Map.get(data, "teamId"),
      "labels" => extract_label_names(data),
      "assignee_id" => Map.get(data, "assigneeId")
    }
  end

  defp build_payload_summary("Comment", data) do
    %{
      "issue_id" => Map.get(data, "issueId"),
      "user_id" => Map.get(data, "userId")
    }
  end

  defp build_payload_summary(_, _data), do: %{}
end
