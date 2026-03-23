defmodule SymphonyElixir.Repo.Migrations.CreateInitialTables do
  use Ecto.Migration

  def change do
    create table(:projects) do
      add :name, :string, null: false
      add :linear_project_slug, :string
      add :linear_organization_slug, :string
      add :linear_filter_by, :string, default: "project"
      add :linear_label_name, :string
      add :github_repo, :string
      add :workspace_root, :string
      add :env_vars, :text
      add :created_at, :utc_datetime, null: false
      add :updated_at, :utc_datetime, null: false
    end

    create table(:sessions) do
      add :issue_id, :string, null: false
      add :issue_identifier, :string
      add :issue_title, :string
      add :session_id, :string, null: false
      add :status, :string, null: false, default: "running"
      add :started_at, :utc_datetime, null: false
      add :ended_at, :utc_datetime
      add :turn_count, :integer, default: 0
      add :input_tokens, :integer, default: 0
      add :output_tokens, :integer, default: 0
      add :total_tokens, :integer, default: 0
      add :worker_host, :string
      add :workspace_path, :string
      add :error, :text
      add :project_id, references(:projects, on_delete: :nilify_all)
      add :agent_session_id, :string
      add :dispatch_source, :string, default: "orchestrator"
    end

    create index(:sessions, [:issue_identifier])
    create index(:sessions, [:status])
    create index(:sessions, [:started_at])
    create index(:sessions, [:project_id])

    create table(:messages) do
      add :session_id, references(:sessions, on_delete: :delete_all), null: false
      add :seq, :integer, null: false
      add :type, :string, null: false
      add :content, :text, null: false
      add :metadata, :text
      add :timestamp, :utc_datetime, null: false
    end

    create index(:messages, [:session_id])

    create table(:settings, primary_key: false) do
      add :key, :string, primary_key: true
      add :value, :string, null: false
    end

    create table(:issue_claims, primary_key: false) do
      add :issue_id, :string, primary_key: true
      add :orchestrator_key, :string, null: false
      add :claimed_at, :utc_datetime, null: false
    end
  end
end
