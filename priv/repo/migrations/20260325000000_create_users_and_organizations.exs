defmodule SymphonyElixir.Repo.Migrations.CreateUsersAndOrganizations do
  use Ecto.Migration

  def change do
    create table(:users, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :email, :string, null: false
      add :hashed_password, :string, null: false
      add :name, :string

      timestamps(type: :utc_datetime)
    end

    create unique_index(:users, [:email])

    create table(:organizations, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :name, :string, null: false
      add :slug, :string, null: false

      timestamps(type: :utc_datetime)
    end

    create unique_index(:organizations, [:slug])

    create table(:user_organizations, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :organization_id, references(:organizations, type: :binary_id, on_delete: :delete_all), null: false
      add :role, :string, null: false, default: "member"
      add :inserted_at, :utc_datetime, null: false
    end

    create index(:user_organizations, [:user_id])
    create index(:user_organizations, [:organization_id])
    create unique_index(:user_organizations, [:user_id, :organization_id])
  end
end
