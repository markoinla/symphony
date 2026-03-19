defmodule SymphonyElixir.Store do
  @moduledoc """
  Persistence API for session and message storage.

  Write-through layer backed by SQLite — the in-memory SessionLog remains
  the primary read path for live sessions; this module provides durable
  storage for historical browsing.
  """

  import Ecto.Query
  alias SymphonyElixir.Repo
  alias SymphonyElixir.Store.{Message, Session}

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

  @spec list_sessions(keyword()) :: [Ecto.Schema.t()]
  def list_sessions(opts \\ []) do
    limit = Keyword.get(opts, :limit, 50)
    offset = Keyword.get(opts, :offset, 0)
    issue_identifier = Keyword.get(opts, :issue_identifier)
    status = Keyword.get(opts, :status)

    Session
    |> order_by([s], desc: s.started_at)
    |> maybe_filter_issue_identifier(issue_identifier)
    |> maybe_filter_status(status)
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
end
