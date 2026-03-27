defmodule SymphonyElixir.Repo.Migrations.CreateWebhookHintQueue do
  use Ecto.Migration

  def change do
    create table(:webhook_hint_queue) do
      add :issue_id, :string, null: false
      add :meta, :map
      add :inserted_at, :utc_datetime, null: false
    end

    create index(:webhook_hint_queue, [:issue_id])
    create index(:webhook_hint_queue, [:inserted_at])
  end
end
