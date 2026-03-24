defmodule SymphonyElixirWeb.ObservabilityApiController do
  @moduledoc """
  JSON API for Symphony observability data.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixir.Store
  alias SymphonyElixirWeb.{Endpoint, Presenter}

  import SymphonyElixirWeb.ErrorHelpers, only: [error_response: 4]

  @spec state(Conn.t(), map()) :: Conn.t()
  def state(conn, _params) do
    json(conn, Presenter.state_payload(orchestrator(), snapshot_timeout_ms()))
  end

  @spec issue(Conn.t(), map()) :: Conn.t()
  def issue(conn, %{"issue_identifier" => issue_identifier}) do
    case Presenter.issue_payload(issue_identifier, orchestrator(), snapshot_timeout_ms()) do
      {:ok, payload} ->
        json(conn, payload)

      {:error, :issue_not_found} ->
        error_response(conn, 404, "issue_not_found", "Issue not found")
    end
  end

  @spec messages(Conn.t(), map()) :: Conn.t()
  def messages(conn, %{"issue_identifier" => issue_identifier}) do
    {:ok, payload} = Presenter.messages_payload(issue_identifier, orchestrator(), snapshot_timeout_ms())
    json(conn, payload)
  end

  @spec sessions(Conn.t(), map()) :: Conn.t()
  def sessions(conn, params) do
    opts =
      []
      |> maybe_put_issue_identifier(params["issue_identifier"])
      |> maybe_put_limit(params["limit"])
      |> maybe_put_project_id(params["project_id"])
      |> maybe_put_workflow_name(params["workflow_name"])

    json(conn, Presenter.history_payload(opts))
  end

  @valid_stats_ranges ~w(24h 7d 30d)

  @spec stats(Conn.t(), map()) :: Conn.t()
  def stats(conn, %{"range" => range} = params) when range in @valid_stats_ranges do
    opts =
      []
      |> maybe_put_project_id(params["project_id"])
      |> maybe_put_workflow_name(params["workflow_name"])

    failure_counts = Store.failure_counts_by_bucket(range, opts)
    dead_letters = Store.dead_letter_sessions(opts)
    worker_health = Store.worker_host_stats(range, opts)

    json(conn, %{
      failure_counts: failure_counts,
      dead_letters:
        Enum.map(dead_letters, fn dl ->
          %{
            id: dl.id,
            issue_identifier: dl.issue_identifier,
            issue_title: dl.issue_title,
            status: dl.status,
            workflow_name: dl.workflow_name,
            error_category: dl.error_category,
            error: dl.error,
            ended_at: format_datetime(dl.ended_at)
          }
        end),
      worker_health: worker_health
    })
  end

  def stats(conn, _params) do
    error_response(conn, 400, "invalid_range", "range must be one of: 24h, 7d, 30d")
  end

  @spec session_debug(Conn.t(), map()) :: Conn.t()
  def session_debug(conn, %{"id" => id_str}) do
    case Integer.parse(id_str) do
      {id, ""} when id > 0 ->
        case Presenter.session_debug_payload(id) do
          {:ok, payload} -> json(conn, payload)
          {:error, :not_found} -> error_response(conn, 404, "session_not_found", "Session not found")
        end

      _ ->
        error_response(conn, 404, "session_not_found", "Session not found")
    end
  end

  @spec refresh(Conn.t(), map()) :: Conn.t()
  def refresh(conn, _params) do
    case Presenter.refresh_payload(orchestrator()) do
      {:ok, payload} ->
        conn
        |> put_status(202)
        |> json(payload)

      {:error, :unavailable} ->
        error_response(conn, 503, "orchestrator_unavailable", "Orchestrator is unavailable")
    end
  end

  @spec healthz(Conn.t(), map()) :: Conn.t()
  def healthz(conn, _params) do
    json(conn, %{status: "ok"})
  end

  defp maybe_put_issue_identifier(opts, issue_identifier)
       when is_binary(issue_identifier) and issue_identifier != "" do
    Keyword.put(opts, :issue_identifier, issue_identifier)
  end

  defp maybe_put_issue_identifier(opts, _issue_identifier), do: opts

  defp maybe_put_limit(opts, limit) when is_binary(limit) do
    case Integer.parse(limit) do
      {value, ""} when value > 0 -> Keyword.put(opts, :limit, min(value, 500))
      _ -> opts
    end
  end

  defp maybe_put_limit(opts, _limit), do: opts

  defp maybe_put_project_id(opts, project_id) when is_binary(project_id) do
    case Integer.parse(project_id) do
      {value, ""} when value > 0 -> Keyword.put(opts, :project_id, value)
      _ -> opts
    end
  end

  defp maybe_put_project_id(opts, _project_id), do: opts

  defp maybe_put_workflow_name(opts, workflow_name)
       when is_binary(workflow_name) and workflow_name != "" do
    Keyword.put(opts, :workflow_name, workflow_name)
  end

  defp maybe_put_workflow_name(opts, _workflow_name), do: opts

  defp orchestrator do
    Endpoint.config(:orchestrator) || SymphonyElixir.Orchestrator.default_source()
  end

  defp snapshot_timeout_ms do
    Endpoint.config(:snapshot_timeout_ms) || 15_000
  end

  defp format_datetime(%DateTime{} = dt), do: dt |> DateTime.truncate(:second) |> DateTime.to_iso8601()
  defp format_datetime(_), do: nil
end
