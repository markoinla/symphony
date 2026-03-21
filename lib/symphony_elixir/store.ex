defmodule SymphonyElixir.Store do
  @moduledoc """
  Persistence API for session and message storage.

  Write-through layer backed by SQLite — the in-memory SessionLog remains
  the primary read path for live sessions; this module provides durable
  storage for historical browsing.
  """

  import Ecto.Query
  alias SymphonyElixir.Repo
  alias SymphonyElixir.Store.{Message, Project, Session, Setting}

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

  # ── Session CRUD ─────────────────────────────────────────────────

  @spec create_session(map()) :: {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t()}
  def create_session(attrs) do
    %Session{}
    |> Session.changeset(attrs)
    |> Repo.insert()
  end

  @spec update_session_codex_id(integer(), String.t()) ::
          {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t() | :not_found}
  def update_session_codex_id(db_session_id, codex_session_id) do
    case Repo.get(Session, db_session_id) do
      nil -> {:error, :not_found}
      session -> session |> Ecto.Changeset.change(session_id: codex_session_id) |> Repo.update()
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

  @spec complete_session_by_codex_session_id(String.t(), map()) ::
          {:ok, Ecto.Schema.t()} | {:error, Ecto.Changeset.t() | :not_found}
  def complete_session_by_codex_session_id(codex_session_id, attrs) do
    case Session
         |> where([s], s.session_id == ^codex_session_id and s.status == "running")
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

    Session
    |> order_by([s], desc: s.started_at)
    |> maybe_filter_issue_identifier(issue_identifier)
    |> maybe_filter_status(status)
    |> maybe_filter_project_id(project_id)
    |> limit(^limit)
    |> offset(^offset)
    |> Repo.all()
  end

  @spec get_session(integer()) :: Ecto.Schema.t() | nil
  def get_session(db_session_id) do
    Repo.get(Session, db_session_id)
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
    where(query, [s], s.project_id == ^project_id)
  end
end
