defmodule SymphonyElixir.Repo.Migrations.CreateWebhookLogs do
  use Ecto.Migration

  def change do
    create table(:webhook_logs) do
      add :webhook_type, :string, null: false
      add :action, :string, null: false
      add :issue_id, :string
      add :issue_identifier, :string
      add :state_name, :string
      add :result, :string, null: false
      add :detail, :text
      add :payload_summary, :map
      add :organization_id, :binary_id
      add :received_at, :utc_datetime, null: false
    end

    create index(:webhook_logs, [:issue_id])
    create index(:webhook_logs, [:issue_identifier])
    create index(:webhook_logs, [:received_at])
    create index(:webhook_logs, [:webhook_type, :action])
  end
end
