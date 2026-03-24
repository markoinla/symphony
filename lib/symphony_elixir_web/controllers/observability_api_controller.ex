defmodule SymphonyElixirWeb.ObservabilityApiController do
  @moduledoc """
  JSON API for Symphony observability data.
  """

  use Phoenix.Controller, formats: [:json]

  alias Ecto.Adapters.SQL
  alias Plug.Conn
  alias SymphonyElixirWeb.{Endpoint, Presenter}

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

    json(conn, Presenter.history_payload(opts))
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
    db_status = check_database()

    components = %{app: "ok", database: db_status}
    all_healthy = db_status == "ok"

    status_code = if all_healthy, do: 200, else: 503
    overall = if all_healthy, do: "ok", else: "degraded"

    conn
    |> put_status(status_code)
    |> json(%{status: overall, components: components})
  end

  @git_sha (if System.find_executable("git") do
              case System.cmd("git", ["rev-parse", "--short", "HEAD"], stderr_to_stdout: true) do
                {sha, 0} -> String.trim(sha)
                _ -> "unknown"
              end
            else
              "unknown"
            end)

  @app_version Mix.Project.config()[:version]

  @spec version(Conn.t(), map()) :: Conn.t()
  def version(conn, _params) do
    json(conn, %{version: @app_version, git_sha: @git_sha})
  end

  @spec method_not_allowed(Conn.t(), map()) :: Conn.t()
  def method_not_allowed(conn, _params) do
    error_response(conn, 405, "method_not_allowed", "Method not allowed")
  end

  @spec not_found(Conn.t(), map()) :: Conn.t()
  def not_found(conn, _params) do
    error_response(conn, 404, "not_found", "Route not found")
  end

  defp check_database do
    case SQL.query(SymphonyElixir.Repo, "SELECT 1", []) do
      {:ok, _result} -> "ok"
      {:error, _reason} -> "degraded"
    end
  rescue
    _ -> "degraded"
  end

  defp error_response(conn, status, code, message) do
    conn
    |> put_status(status)
    |> json(%{error: %{code: code, message: message}})
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

  defp orchestrator do
    Endpoint.config(:orchestrator) || SymphonyElixir.Orchestrator.default_source()
  end

  defp snapshot_timeout_ms do
    Endpoint.config(:snapshot_timeout_ms) || 15_000
  end
end
