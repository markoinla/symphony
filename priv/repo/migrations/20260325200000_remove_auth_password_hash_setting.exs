defmodule SymphonyElixir.Repo.Migrations.RemoveAuthPasswordHashSetting do
  use Ecto.Migration

  def up do
    execute("DELETE FROM settings WHERE key = 'auth_password_hash'")
  end

  def down do
    # No-op: the old password hash cannot be restored
    :ok
  end
end
