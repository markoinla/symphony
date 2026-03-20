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
  alias SymphonyElixir.Store

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

    SQL.query!(Repo, """
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      linear_project_slug TEXT,
      linear_organization_slug TEXT,
      linear_filter_by TEXT DEFAULT 'project',
      linear_label_name TEXT,
      github_repo TEXT,
      workspace_root TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    """)

    SQL.query!(Repo, """
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
    """)

    maybe_add_column("sessions", "project_id", "INTEGER")

    SQL.query!(Repo, """
    CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id)
    """)

    maybe_import_settings_file()

    Logger.info("SQLite auto-migrations complete")
  end

  defp maybe_add_column(table, column, type) do
    case SQL.query(Repo, "SELECT #{column} FROM #{table} LIMIT 0") do
      {:ok, _} ->
        :ok

      {:error, _} ->
        SQL.query!(Repo, "ALTER TABLE #{table} ADD COLUMN #{column} #{type}")
    end
  end

  defp maybe_import_settings_file do
    settings_path = settings_file_path()

    if File.exists?(settings_path) and project_count() == 0 do
      Logger.info("Importing settings from #{settings_path}")

      case File.read(settings_path) do
        {:ok, content} ->
          case Jason.decode(content) do
            {:ok, map} when is_map(map) ->
              import_settings_map(map)
              migrated_path = settings_path <> ".migrated"
              File.rename(settings_path, migrated_path)
              Logger.info("Settings imported; original file renamed to #{migrated_path}")

            _ ->
              Logger.warning("Failed to decode settings JSON from #{settings_path}")
          end

        {:error, reason} ->
          Logger.warning("Failed to read settings file #{settings_path}: #{inspect(reason)}")
      end
    end
  end

  defp import_settings_map(map) do
    project_slug = Map.get(map, "tracker.project_slug")
    org_slug = Map.get(map, "tracker.organization_slug")
    github_repo = Map.get(map, "github.repo")

    if project_slug || github_repo do
      project_name =
        cond do
          is_binary(github_repo) and github_repo != "" ->
            github_repo |> String.split("/") |> List.last()

          is_binary(project_slug) and project_slug != "" ->
            project_slug

          true ->
            "Default"
        end

      now = DateTime.utc_now()

      Store.create_project(%{
        name: project_name,
        linear_project_slug: project_slug,
        linear_organization_slug: org_slug,
        github_repo: github_repo,
        created_at: now,
        updated_at: now
      })
    end

    global_keys = ["tracker.api_key", "agent.max_concurrent_agents", "polling.interval_ms", "codex.command"]

    global_settings =
      map
      |> Map.take(global_keys)
      |> Enum.reject(fn {_k, v} -> is_nil(v) or v == "" end)
      |> Map.new(fn {k, v} -> {k, to_string(v)} end)

    if map_size(global_settings) > 0 do
      Store.set_settings(global_settings)
    end
  end

  defp project_count do
    case SQL.query(Repo, "SELECT COUNT(*) FROM projects") do
      {:ok, %{rows: [[count]]}} -> count
      _ -> 0
    end
  end

  defp settings_file_path do
    alias SymphonyElixir.Workflow

    Workflow.workflow_file_path()
    |> Path.dirname()
    |> Path.join(".symphony_settings.json")
  end
end
