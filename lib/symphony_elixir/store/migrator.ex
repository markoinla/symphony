defmodule SymphonyElixir.Store.Migrator do
  @moduledoc """
  Runs CREATE TABLE IF NOT EXISTS on Repo startup.

  Uses raw SQL instead of Ecto migrations — simpler for an internal tool
  with a local SQLite file.
  """

  use GenServer
  require Logger

  alias Ecto.Adapters.SQL
  alias SymphonyElixir.Repo

  @spec start_link(term()) :: GenServer.on_start()
  def start_link(_opts) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @impl true
  def init(:ok) do
    run_migrations()
    {:ok, :done}
  end

  defp run_migrations do
    Logger.info("Running SQLite auto-migrations")

    SQL.query!(Repo, """
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT,
      issue_title TEXT,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      turn_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      worker_host TEXT,
      workspace_path TEXT,
      error TEXT
    )
    """)

    SQL.query!(Repo, """
    CREATE INDEX IF NOT EXISTS idx_sessions_issue_identifier ON sessions(issue_identifier)
    """)

    SQL.query!(Repo, """
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)
    """)

    SQL.query!(Repo, """
    CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at)
    """)

    SQL.query!(Repo, """
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      timestamp TEXT NOT NULL
    )
    """)

    SQL.query!(Repo, """
    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)
    """)

    Logger.info("SQLite auto-migrations complete")
  end
end
