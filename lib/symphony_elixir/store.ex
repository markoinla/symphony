defmodule SymphonyElixir.Store do
  @moduledoc """
  Persistence API for session and message storage.

  Write-through layer backed by PostgreSQL — the in-memory SessionLog remains
  the primary read path for live sessions; this module provides durable
  storage for historical browsing.
  """

  import Ecto.Query
  alias SymphonyElixir.Repo
  alias SymphonyElixir.Store.{Agent, IssueClaim, Message, Project, Session, Setting}

  # ── Agent CRUD ─────────────────────────────────────────────────────

  @spec list_agents() :: [Agent.t()]
  def list_agents do
    Agent
    |> order_by([a], asc: a.name)
    |> Repo.all()
  end

  @spec get_agent_by_name(String.t()) :: Agent.t() | nil
  def get_agent_by_name(name) when is_binary(name) do
    Repo.get_by(Agent, name: name)
  end

  @spec update_agent(String.t(), map()) :: {:ok, Agent.t()} | {:error, Ecto.Changeset.t() | :not_found}
  def update_agent(name, attrs) when is_binary(name) and is_map(attrs) do
    case Repo.get_by(Agent, name: name) do
      nil ->
        {:error, :not_found}

      agent ->
        agent
        |> Agent.changeset(attrs)
        |> Ecto.Changeset.put_change(:updated_at, DateTime.truncate(DateTime.utc_now(), :second))
        |> Repo.update()
    end
  end

  @spec upsert_agent(map()) :: {:ok, Agent.t()} | {:error, Ecto.Changeset.t()}
  def upsert_agent(attrs) when is_map(attrs) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    attrs =
      attrs
      |> Map.put(:inserted_at, now)
      |> Map.put(:updated_at, now)

    %Agent{}
    |> Agent.changeset(attrs)
    |> Ecto.Changeset.put_change(:inserted_at, now)
    |> Ecto.Changeset.put_change(:updated_at, now)
    |> Repo.insert(
      on_conflict: [set: [updated_at: now]],
      conflict_target: :name
    )
  end

  # ── Project CRUD ──────────────────────────────────────────────────

  @spec list_projects() :: [Ecto.Schema.t()]
  def list_projects do
    Project
    |> order_by([p], asc: p.name)
    |> Repo.all()
  end

  @spec get_project(integer()) :: Ecto.Schema.t() | nil
  def get_project(id) do
    Repo.get(Project, id)
  end

  @spec get_project_by_name(String.t()) :: Ecto.Schema.t() | nil
  def get_project_by_name(name) do
    Repo.get_by(Project, name: name)
  end

  @spec create_project(map()) :: {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t()}
  def create_project(attrs) do
    now =
      (Map.get(attrs, :created_at) || Map.get(attrs, "created_at") || DateTime.utc_now())
      |> DateTime.truncate(:second)

    attrs =
      attrs
      |> Map.put(:created_at, now)
      |> Map.put_new(:updated_at, now)

    %Project{}
    |> Project.changeset(attrs)
    |> Ecto.Changeset.put_change(:created_at, now)
    |> Ecto.Changeset.put_change(:updated_at, now)
    |> Repo.insert()
  end

  @spec update_project(integer(), map()) :: {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t() | :not_found}
  def update_project(id, attrs) do
    case Repo.get(Project, id) do
      nil ->
        {:error, :not_found}

      project ->
        project
        |> Project.changeset(attrs)
        |> Ecto.Changeset.put_change(:updated_at, DateTime.truncate(DateTime.utc_now(), :second))
        |> Repo.update()
    end
  end

  @spec delete_project(integer()) :: {:ok, Ecto.Schema.t()} | {:error, :not_found}
  def delete_project(id) do
    case Repo.get(Project, id) do
      nil -> {:error, :not_found}
      project -> Repo.delete(project)
    end
  end

  # ── Global Settings ──────────────────────────────────────────────

  @spec get_setting(String.t()) :: String.t() | nil
  def get_setting(key) do
    case Repo.get(Setting, key) do
      nil -> nil
      setting -> setting.value
    end
  end

  @spec list_settings() :: [Ecto.Schema.t()]
  def list_settings do
    Repo.all(Setting)
  end

  @spec all_settings() :: [Ecto.Schema.t()]
  def all_settings do
    list_settings()
  end

  @spec put_setting(String.t(), String.t()) :: {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t()}
  def put_setting(key, value) do
    %Setting{key: key}
    |> Setting.changeset(%{key: key, value: to_string(value)})
    |> Repo.insert(on_conflict: :replace_all, conflict_target: :key)
  end

  @spec set_setting(String.t(), String.t()) :: {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t()}
  def set_setting(key, value) do
    put_setting(key, value)
  end

  @spec set_settings(map()) :: :ok
  def set_settings(settings_map) when is_map(settings_map) do
    Enum.each(settings_map, fn {key, value} ->
      put_setting(to_string(key), to_string(value))
    end)

    :ok
  end

  @spec delete_setting(String.t()) :: {:ok, Ecto.Schema.t()} | {:error, :not_found}
  def delete_setting(key) do
    case Repo.get(Setting, key) do
      nil -> {:error, :not_found}
      setting -> Repo.delete(setting)
    end
  end

  @spec delete_all_settings() :: :ok
  def delete_all_settings do
    Repo.delete_all(Setting)
    :ok
  end

  @spec delete_all_projects() :: :ok
  def delete_all_projects do
    Repo.delete_all(Project)
    :ok
  end

  # ── Issue Claims ────────────────────────────────────────────────

  @spec claim_issue(String.t(), String.t()) :: {:ok, :claimed} | {:error, :already_claimed}
  def claim_issue(issue_id, orchestrator_key)
      when is_binary(issue_id) and is_binary(orchestrator_key) do
    case Repo.get(IssueClaim, issue_id) do
      %IssueClaim{} ->
        {:error, :already_claimed}

      nil ->
        %IssueClaim{}
        |> IssueClaim.changeset(%{
          issue_id: issue_id,
          orchestrator_key: orchestrator_key,
          claimed_at: DateTime.utc_now()
        })
        |> Repo.insert()
        |> case do
          {:ok, _claim} -> {:ok, :claimed}
          {:error, _changeset} -> {:error, :already_claimed}
        end
    end
  end

  @spec release_issue_claim(String.t()) :: :ok
  def release_issue_claim(issue_id) when is_binary(issue_id) do
    IssueClaim
    |> where([c], c.issue_id == ^issue_id)
    |> Repo.delete_all()

    :ok
  end

  @spec list_claimed_issue_ids() :: MapSet.t(String.t())
  def list_claimed_issue_ids do
    IssueClaim
    |> select([c], c.issue_id)
    |> Repo.all()
    |> MapSet.new()
  end

  @spec clear_all_issue_claims() :: :ok
  def clear_all_issue_claims do
    Repo.delete_all(IssueClaim)
    :ok
  end

  # ── Session CRUD ─────────────────────────────────────────────────

  @spec create_session(map()) :: {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t()}
  def create_session(attrs) do
    %Session{}
    |> Session.changeset(attrs)
    |> Repo.insert()
  end

  @spec update_session_engine_id(integer(), String.t()) ::
          {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t() | :not_found}
  def update_session_engine_id(db_session_id, engine_session_id) do
    case Repo.get(Session, db_session_id) do
      nil -> {:error, :not_found}
      session -> session |> Ecto.Changeset.change(session_id: engine_session_id) |> Repo.update()
    end
  end

  @spec complete_session(integer(), map()) :: {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t() | :not_found}
  def complete_session(db_session_id, attrs) do
    case Repo.get(Session, db_session_id) do
      nil ->
        {:error, :not_found}

      session ->
        session
        |> Session.changeset(Map.put(attrs, :ended_at, DateTime.utc_now()))
        |> Repo.update()
    end
  end

  @spec update_session_stderr(integer(), String.t()) ::
          {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t() | :not_found}
  def update_session_stderr(db_session_id, stderr) when is_binary(stderr) do
    case Repo.get(Session, db_session_id) do
      nil -> {:error, :not_found}
      session -> session |> Ecto.Changeset.change(stderr: stderr) |> Repo.update()
    end
  end

  @spec complete_session_by_engine_session_id(String.t(), map()) ::
          {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t() | :not_found}
  def complete_session_by_engine_session_id(session_id, attrs) do
    case Session
         |> where([s], s.session_id == ^session_id and s.status == "running")
         |> order_by([s], desc: s.started_at)
         |> limit(1)
         |> Repo.one() do
      nil ->
        {:error, :not_found}

      session ->
        session
        |> Session.changeset(Map.put(attrs, :ended_at, DateTime.utc_now()))
        |> Repo.update()
    end
  end

  @spec append_message(integer(), map()) :: {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t()}
  def append_message(db_session_id, message_attrs) do
    %Message{}
    |> Message.changeset(Map.put(message_attrs, :session_id, db_session_id))
    |> Repo.insert()
  end

  @spec update_message_content(integer(), integer(), String.t()) ::
          {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t() | :not_found}
  def update_message_content(db_session_id, seq, new_content) do
    case Message
         |> where([m], m.session_id == ^db_session_id and m.seq == ^seq)
         |> Repo.one() do
      nil -> {:error, :not_found}
      msg -> msg |> Ecto.Changeset.change(content: new_content) |> Repo.update()
    end
  end

  @spec update_message_metadata(integer(), integer(), String.t()) ::
          {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t() | :not_found}
  def update_message_metadata(db_session_id, seq, new_metadata) do
    case Message
         |> where([m], m.session_id == ^db_session_id and m.seq == ^seq)
         |> Repo.one() do
      nil -> {:error, :not_found}
      msg -> msg |> Ecto.Changeset.change(metadata: new_metadata) |> Repo.update()
    end
  end

  @spec list_sessions(keyword()) :: [Ecto.Schema.t()]
  def list_sessions(opts \\ []) do
    limit = Keyword.get(opts, :limit, 50)
    offset = Keyword.get(opts, :offset, 0)
    issue_identifier = Keyword.get(opts, :issue_identifier)
    status = Keyword.get(opts, :status)
    project_id = Keyword.get(opts, :project_id)
    workflow_name = Keyword.get(opts, :workflow_name)

    Session
    |> order_by([s], desc: s.started_at)
    |> maybe_filter_issue_identifier(issue_identifier)
    |> maybe_filter_status(status)
    |> maybe_filter_project_id(project_id)
    |> maybe_filter_workflow_name(workflow_name)
    |> limit(^limit)
    |> offset(^offset)
    |> Repo.all()
  end

  @spec get_session(integer()) :: Ecto.Schema.t() | nil
  def get_session(db_session_id) do
    Repo.get(Session, db_session_id)
  end

  @spec get_session_debug(integer()) :: Ecto.Schema.t() | nil
  def get_session_debug(db_session_id) do
    Session
    |> where([s], s.id == ^db_session_id)
    |> preload(messages: ^from(m in Message, order_by: [asc: m.seq]))
    |> Repo.one()
  end

  @spec find_session_by_agent_session_id(String.t()) :: Ecto.Schema.t() | nil
  def find_session_by_agent_session_id(agent_session_id) when is_binary(agent_session_id) do
    Session
    |> where([s], s.agent_session_id == ^agent_session_id)
    |> limit(1)
    |> Repo.one()
  end

  @spec update_session_agent_session_id(integer(), String.t()) ::
          {:ok, Ecto.Schema.t()} | {:error, term()}
  def update_session_agent_session_id(db_session_id, agent_session_id)
      when is_integer(db_session_id) and is_binary(agent_session_id) do
    case get_session(db_session_id) do
      nil ->
        {:error, :not_found}

      session ->
        session
        |> Ecto.Changeset.change(agent_session_id: agent_session_id)
        |> Repo.update()
    end
  end

  @spec get_session_messages(integer()) :: [Ecto.Schema.t()]
  def get_session_messages(db_session_id) do
    Message
    |> where([m], m.session_id == ^db_session_id)
    |> order_by([m], asc: m.seq)
    |> Repo.all()
  end

  defp maybe_filter_issue_identifier(query, nil), do: query

  defp maybe_filter_issue_identifier(query, identifier) do
    where(query, [s], s.issue_identifier == ^identifier)
  end

  defp maybe_filter_status(query, nil), do: query

  defp maybe_filter_status(query, status) do
    where(query, [s], s.status == ^status)
  end

  defp maybe_filter_workflow_name(query, nil), do: query

  defp maybe_filter_workflow_name(query, workflow_name) do
    where(query, [s], s.workflow_name == ^workflow_name)
  end

  @spec finalize_stale_sessions(keyword()) :: {integer(), nil}
  def finalize_stale_sessions(opts \\ []) do
    project_id = Keyword.get(opts, :project_id)
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Session
    |> where([s], s.status == "running")
    |> maybe_filter_project_id(project_id)
    |> Repo.update_all(set: [status: "cancelled", ended_at: now, error: "orchestrator restarted"])
  end

  defp maybe_filter_project_id(query, nil), do: query

  defp maybe_filter_project_id(query, project_id) do
    case Repo.get(Project, project_id) do
      %Project{workspace_root: workspace_root} when is_binary(workspace_root) and workspace_root != "" ->
        legacy_workspace_pattern = legacy_workspace_pattern(workspace_root)

        where(
          query,
          [s],
          s.project_id == ^project_id or
            (is_nil(s.project_id) and fragment("? LIKE ? ESCAPE '\\'", s.workspace_path, ^legacy_workspace_pattern))
        )

      _ ->
        where(query, [s], s.project_id == ^project_id)
    end
  end

  defp legacy_workspace_pattern(workspace_root) do
    workspace_root
    |> String.replace("\\", "\\\\")
    |> String.replace("%", "\\%")
    |> String.replace("_", "\\_")
    |> Path.join("%")
  end

  # ── Session Stats ────────────────────────────────────────────────

  @spec failure_counts_by_bucket(String.t(), keyword()) :: [map()]
  def failure_counts_by_bucket(range, opts \\ []) when range in ["24h", "7d", "30d"] do
    {since, _trunc} = stats_range_params(range)

    base =
      Session
      |> where([s], s.status == "failed" and s.ended_at >= ^since)
      |> maybe_filter_project_id(Keyword.get(opts, :project_id))
      |> maybe_filter_workflow_name(Keyword.get(opts, :workflow_name))

    base
    |> failure_bucket_query(range)
    |> Repo.all()
    |> pivot_failure_buckets()
  end

  defp failure_bucket_query(query, "24h") do
    query
    |> group_by([s], [fragment("date_trunc('hour', ?)", s.ended_at), s.error_category])
    |> select([s], %{
      bucket: fragment("date_trunc('hour', ?)", s.ended_at),
      error_category: s.error_category,
      count: count(s.id)
    })
  end

  defp failure_bucket_query(query, _range) do
    query
    |> group_by([s], [fragment("date_trunc('day', ?)", s.ended_at), s.error_category])
    |> select([s], %{
      bucket: fragment("date_trunc('day', ?)", s.ended_at),
      error_category: s.error_category,
      count: count(s.id)
    })
  end

  @spec dead_letter_sessions(keyword()) :: [map()]
  def dead_letter_sessions(opts \\ []) do
    sub =
      Session
      |> where([s2], s2.issue_id == parent_as(:parent).issue_id and s2.started_at > parent_as(:parent).started_at)
      |> select([s2], s2.id)
      |> limit(1)

    Session
    |> from(as: :parent)
    |> where([s], s.status == "failed")
    |> where([s], not exists(sub))
    |> maybe_filter_project_id(Keyword.get(opts, :project_id))
    |> maybe_filter_workflow_name(Keyword.get(opts, :workflow_name))
    |> order_by([s], desc: s.ended_at)
    |> limit(50)
    |> select([s], %{
      id: s.id,
      issue_id: s.issue_id,
      issue_identifier: s.issue_identifier,
      issue_title: s.issue_title,
      workflow_name: s.workflow_name,
      error_category: s.error_category,
      error: s.error,
      ended_at: s.ended_at
    })
    |> Repo.all()
  end

  @spec worker_host_stats(String.t(), keyword()) :: [map()]
  def worker_host_stats(range, opts \\ []) when range in ["24h", "7d", "30d"] do
    {since, _trunc} = stats_range_params(range)

    Session
    |> where([s], not is_nil(s.worker_host) and s.started_at >= ^since)
    |> maybe_filter_project_id(Keyword.get(opts, :project_id))
    |> maybe_filter_workflow_name(Keyword.get(opts, :workflow_name))
    |> group_by([s], s.worker_host)
    |> select([s], %{
      host: s.worker_host,
      total_runs: count(s.id),
      failures: fragment("count(*) filter (where ? = 'failed')", s.status)
    })
    |> Repo.all()
    |> Enum.map(fn row ->
      total = row.total_runs || 0
      failures = row.failures || 0
      rate = if total > 0, do: failures / total, else: 0.0

      %{
        host: row.host,
        total_runs: total,
        failures: failures,
        failure_rate: Float.round(rate * 1.0, 4)
      }
    end)
  end

  defp stats_range_params("24h") do
    since = DateTime.utc_now() |> DateTime.add(-24, :hour) |> DateTime.truncate(:second)
    {since, "hour"}
  end

  defp stats_range_params("7d") do
    since = DateTime.utc_now() |> DateTime.add(-7, :day) |> DateTime.truncate(:second)
    {since, "day"}
  end

  defp stats_range_params("30d") do
    since = DateTime.utc_now() |> DateTime.add(-30, :day) |> DateTime.truncate(:second)
    {since, "day"}
  end

  defp pivot_failure_buckets(rows) do
    rows
    |> Enum.group_by(& &1.bucket)
    |> Enum.sort_by(fn {bucket, _rows} -> bucket end, NaiveDateTime)
    |> Enum.map(&format_failure_bucket/1)
  end

  defp format_failure_bucket({bucket, category_rows}) do
    counts = tally_categories(category_rows)

    %{
      bucket: bucket |> DateTime.from_naive!("Etc/UTC") |> DateTime.truncate(:second) |> DateTime.to_iso8601(),
      infra: counts.infra,
      agent: counts.agent,
      config: counts.config,
      timeout: counts.timeout
    }
  end

  defp tally_categories(category_rows) do
    Enum.reduce(category_rows, %{infra: 0, agent: 0, config: 0, timeout: 0}, fn row, acc ->
      case row.error_category do
        cat when cat in ~w(infra agent config timeout) ->
          Map.update!(acc, String.to_existing_atom(cat), &(&1 + row.count))

        _ ->
          acc
      end
    end)
  end

  # ── Analytics ─────────────────────────────────────────────────────

  @spec analytics_cost(String.t()) :: map()
  def analytics_cost(range) when range in ["7d", "30d", "90d"] do
    days = range_to_days(range)
    since = DateTime.utc_now() |> DateTime.add(-days, :day) |> DateTime.truncate(:second)

    summary = summary_query(since)
    daily = daily_query(since)
    by_workflow = by_workflow_query(since)

    %{
      range: range,
      summary: summary,
      daily: daily,
      by_workflow: by_workflow
    }
  end

  defp range_to_days("7d"), do: 7
  defp range_to_days("30d"), do: 30
  defp range_to_days("90d"), do: 90

  defp summary_query(since) do
    result =
      Session
      |> where([s], s.started_at >= ^since and not is_nil(s.estimated_cost_cents))
      |> select([s], %{
        total_cost_cents: coalesce(sum(s.estimated_cost_cents), 0),
        total_sessions: count(s.id),
        total_input_tokens: coalesce(sum(s.input_tokens), 0),
        total_output_tokens: coalesce(sum(s.output_tokens), 0)
      })
      |> Repo.one()

    %{
      total_cost_cents: result.total_cost_cents || 0,
      total_sessions: result.total_sessions || 0,
      total_input_tokens: result.total_input_tokens || 0,
      total_output_tokens: result.total_output_tokens || 0
    }
  end

  defp daily_query(since) do
    Session
    |> where([s], s.started_at >= ^since and not is_nil(s.workflow))
    |> group_by([s], [fragment("date_trunc('day', ?)", s.started_at), s.workflow])
    |> order_by([s], asc: fragment("date_trunc('day', ?)", s.started_at))
    |> select([s], %{
      date: fragment("date_trunc('day', ?)", s.started_at),
      workflow: s.workflow,
      cost_cents: coalesce(sum(s.estimated_cost_cents), 0),
      sessions: count(s.id),
      input_tokens: coalesce(sum(s.input_tokens), 0),
      output_tokens: coalesce(sum(s.output_tokens), 0)
    })
    |> Repo.all()
    |> Enum.map(fn row ->
      %{
        date: row.date |> NaiveDateTime.to_date() |> Date.to_iso8601(),
        workflow: row.workflow,
        cost_cents: row.cost_cents || 0,
        sessions: row.sessions || 0,
        input_tokens: row.input_tokens || 0,
        output_tokens: row.output_tokens || 0
      }
    end)
  end

  defp by_workflow_query(since) do
    Session
    |> where([s], s.started_at >= ^since and not is_nil(s.workflow))
    |> group_by([s], s.workflow)
    |> select([s], %{
      workflow: s.workflow,
      cost_cents: coalesce(sum(s.estimated_cost_cents), 0),
      sessions: count(s.id),
      input_tokens: coalesce(sum(s.input_tokens), 0),
      output_tokens: coalesce(sum(s.output_tokens), 0)
    })
    |> Repo.all()
    |> Enum.map(fn row ->
      cost = row.cost_cents || 0
      sessions = row.sessions || 0
      avg = if sessions > 0, do: div(cost, sessions), else: 0

      %{
        workflow: row.workflow,
        cost_cents: cost,
        sessions: sessions,
        input_tokens: row.input_tokens || 0,
        output_tokens: row.output_tokens || 0,
        avg_cost_cents_per_session: avg
      }
    end)
  end
end
