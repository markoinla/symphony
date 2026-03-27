defmodule SymphonyElixirWeb.ObservabilityApiController do
  @moduledoc """
  JSON API for Symphony observability data.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixir.{Config, Store, WorkflowStore}
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
      [org_id: org_id(conn)]
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
      [org_id: org_id(conn)]
      |> maybe_put_project_id(params["project_id"])
      |> maybe_put_workflow_name(params["workflow_name"])

    failure_counts = Store.failure_counts_by_bucket(range, opts)
    run_counts = Store.run_counts_by_bucket(range, opts)
    dead_letters = Store.dead_letter_sessions(opts)
    worker_health = Store.worker_host_stats(range, opts)

    json(conn, %{
      failure_counts: failure_counts,
      run_counts: run_counts,
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

  @spec diagnostics(Conn.t(), map()) :: Conn.t()
  def diagnostics(conn, _params) do
    diagnostics = %{
      system: system_diagnostics(),
      orchestrator: Presenter.state_payload(orchestrator(), snapshot_timeout_ms()),
      workflows: workflow_diagnostics(),
      database: database_diagnostics(),
      issue_claims: issue_claims_diagnostics(),
      worker_health: Store.worker_host_stats("24h"),
      dead_letters: dead_letter_diagnostics(),
      webhooks: webhook_diagnostics(),
      error_distribution: error_distribution_diagnostics(),
      projects: project_diagnostics(),
      recent_errors: recent_error_diagnostics()
    }

    json(conn, diagnostics)
  end

  # ── Diagnostics helpers ───────────────────────────────────────────

  defp system_diagnostics do
    {uptime_ms, _} = :erlang.statistics(:wall_clock)

    %{
      node: node(),
      otp_release: :erlang.system_info(:otp_release) |> List.to_string(),
      elixir_version: System.version(),
      uptime_seconds: div(uptime_ms, 1_000),
      system_time: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601(),
      schedulers: :erlang.system_info(:schedulers_online),
      process_count: :erlang.system_info(:process_count),
      process_limit: :erlang.system_info(:process_limit),
      memory: memory_diagnostics(),
      registries: registry_diagnostics()
    }
  end

  defp memory_diagnostics do
    mem = :erlang.memory()

    %{
      total_mb: Float.round(mem[:total] / 1_048_576, 1),
      processes_mb: Float.round(mem[:processes] / 1_048_576, 1),
      ets_mb: Float.round(mem[:ets] / 1_048_576, 1),
      binary_mb: Float.round(mem[:binary] / 1_048_576, 1)
    }
  end

  defp registry_diagnostics do
    %{
      session_logs: Registry.count(SymphonyElixir.SessionLogRegistry),
      orchestrators: Registry.count(SymphonyElixir.OrchestratorRegistry),
      agent_sessions: Registry.count(SymphonyElixir.AgentSessionRegistry)
    }
  end

  defp workflow_diagnostics do
    WorkflowStore.workflow_names()
    |> Enum.map(fn name ->
      settings = Config.settings!(name)

      %{
        workflow_name: name,
        active_states: settings.tracker.active_states,
        terminal_states: settings.tracker.terminal_states,
        max_concurrent_agents: settings.agent.max_concurrent_agents,
        max_concurrent_agents_by_state: settings.agent.max_concurrent_agents_by_state,
        max_failure_retries: settings.agent.max_failure_retries,
        retry_cooldown_ms: settings.agent.retry_cooldown_ms,
        poll_interval_ms: settings.polling.interval_ms,
        webhook_enabled: settings.webhook.enabled,
        workers: workflow_worker_info(settings)
      }
    end)
  end

  defp workflow_worker_info(settings) do
    case settings.worker do
      %{ssh_hosts: hosts} when is_list(hosts) and hosts != [] ->
        %{
          mode: "ssh",
          hosts: hosts,
          max_per_host: settings.worker.max_concurrent_agents_per_host
        }

      _ ->
        %{mode: "local"}
    end
  end

  defp database_diagnostics do
    session_counts = Store.session_counts_by_status()
    pool_stats = ecto_pool_stats()

    %{
      session_counts: session_counts,
      total_sessions: session_counts |> Map.values() |> Enum.sum(),
      ecto_pool: pool_stats
    }
  end

  defp ecto_pool_stats do
    repo_config = Application.get_env(:symphony_elixir, SymphonyElixir.Repo, [])

    %{
      pool_size: repo_config[:pool_size] || 10,
      pool: to_string(repo_config[:pool] || DBConnection.ConnectionPool)
    }
  end

  defp issue_claims_diagnostics do
    claims = Store.list_issue_claims()

    %{
      count: length(claims),
      claims:
        Enum.map(claims, fn c ->
          %{
            issue_id: c.issue_id,
            orchestrator_key: c.orchestrator_key,
            claimed_at: format_datetime(c.claimed_at)
          }
        end)
    }
  end

  defp dead_letter_diagnostics do
    Store.dead_letter_sessions()
    |> Enum.map(fn dl ->
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
    end)
  end

  defp webhook_diagnostics do
    logs = Store.list_webhook_logs(limit: 20)

    %{
      recent_count: length(logs),
      logs:
        Enum.map(logs, fn w ->
          %{
            id: w.id,
            webhook_type: w.webhook_type,
            action: w.action,
            issue_identifier: w.issue_identifier,
            state_name: w.state_name,
            result: w.result,
            detail: w.detail,
            received_at: format_datetime(w.received_at)
          }
        end)
    }
  end

  defp error_distribution_diagnostics do
    failure_counts = Store.failure_counts_by_bucket("24h")

    totals =
      Enum.reduce(failure_counts, %{infra: 0, agent: 0, config: 0, timeout: 0}, fn bucket, acc ->
        %{
          infra: acc.infra + Map.get(bucket, :infra, 0),
          agent: acc.agent + Map.get(bucket, :agent, 0),
          config: acc.config + Map.get(bucket, :config, 0),
          timeout: acc.timeout + Map.get(bucket, :timeout, 0)
        }
      end)

    %{
      range: "24h",
      totals: totals,
      total: totals.infra + totals.agent + totals.config + totals.timeout,
      by_bucket: failure_counts
    }
  end

  defp project_diagnostics do
    Store.list_projects()
    |> Enum.map(fn p ->
      %{
        id: p.id,
        name: p.name,
        linear_project_id: p.linear_project_id,
        github_repo: p.github_repo,
        github_branch: p.github_branch
      }
    end)
  end

  defp recent_error_diagnostics do
    Store.list_sessions(limit: 20, status: "error")
    |> Enum.map(fn s ->
      %{
        id: s.id,
        issue_identifier: s.issue_identifier,
        issue_title: s.issue_title,
        workflow_name: s.workflow_name,
        error: s.error,
        error_category: s.error_category,
        worker_host: s.worker_host,
        started_at: format_datetime(s.started_at),
        ended_at: format_datetime(s.ended_at)
      }
    end)
  end

  # ── Shared helpers ──────────────────────────────────────────────

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
    case Endpoint.config(:orchestrator) do
      source when is_list(source) and source != [] -> source
      source when not is_nil(source) and not is_list(source) -> source
      _nil_or_empty -> SymphonyElixir.Orchestrator.default_source()
    end
  end

  defp snapshot_timeout_ms do
    Endpoint.config(:snapshot_timeout_ms) || 15_000
  end

  defp format_datetime(%DateTime{} = dt), do: dt |> DateTime.truncate(:second) |> DateTime.to_iso8601()
  defp format_datetime(_), do: nil

  defp org_id(conn) do
    case conn.assigns[:current_org] do
      %{id: id} -> id
      _ -> nil
    end
  end
end
