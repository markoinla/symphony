defmodule SymphonyElixir.Repo.Migrations.AddOrganizationIdToScopedTables do
  use Ecto.Migration

  def up do
    # Step 1: Add nullable organization_id columns with FK references
    alter table(:projects) do
      add(:organization_id, references(:organizations, type: :binary_id, on_delete: :restrict))
    end

    alter table(:sessions) do
      add(:organization_id, references(:organizations, type: :binary_id, on_delete: :restrict))
    end

    alter table(:issue_claims) do
      add(:organization_id, references(:organizations, type: :binary_id, on_delete: :restrict))
    end

    flush()

    # Step 2: Ensure a default organization exists for backfill.
    # On a fresh DB there may be scoped rows but no organization yet (e.g. test seeds).
    execute("""
    INSERT INTO organizations (id, name, slug, inserted_at, updated_at)
    SELECT gen_random_uuid(), 'Default', 'default',
           NOW() AT TIME ZONE 'UTC', NOW() AT TIME ZONE 'UTC'
    WHERE NOT EXISTS (SELECT 1 FROM organizations)
      AND (EXISTS (SELECT 1 FROM projects)
        OR EXISTS (SELECT 1 FROM sessions)
        OR EXISTS (SELECT 1 FROM issue_claims))
    """)

    # Step 3: Backfill existing rows with the first organization
    execute("""
    UPDATE projects
    SET organization_id = (SELECT id FROM organizations ORDER BY inserted_at ASC LIMIT 1)
    WHERE organization_id IS NULL
    """)

    execute("""
    UPDATE sessions
    SET organization_id = (SELECT id FROM organizations ORDER BY inserted_at ASC LIMIT 1)
    WHERE organization_id IS NULL
    """)

    execute("""
    UPDATE issue_claims
    SET organization_id = (SELECT id FROM organizations ORDER BY inserted_at ASC LIMIT 1)
    WHERE organization_id IS NULL
    """)

    flush()

    # Step 4: Add NOT NULL constraints after backfill
    execute("ALTER TABLE projects ALTER COLUMN organization_id SET NOT NULL")
    execute("ALTER TABLE sessions ALTER COLUMN organization_id SET NOT NULL")
    execute("ALTER TABLE issue_claims ALTER COLUMN organization_id SET NOT NULL")

    # Step 5: Add indexes for query performance
    create(index(:projects, [:organization_id]))
    create(index(:sessions, [:organization_id]))
    create(index(:issue_claims, [:organization_id]))
  end

  def down do
    drop_if_exists(index(:issue_claims, [:organization_id]))
    drop_if_exists(index(:sessions, [:organization_id]))
    drop_if_exists(index(:projects, [:organization_id]))

    alter table(:issue_claims) do
      remove(:organization_id)
    end

    alter table(:sessions) do
      remove(:organization_id)
    end

    alter table(:projects) do
      remove(:organization_id)
    end
  end
end
