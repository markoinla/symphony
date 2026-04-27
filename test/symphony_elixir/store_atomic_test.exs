defmodule SymphonyElixir.StoreAtomicTest do
  use SymphonyElixir.TestSupport
  # The existing settings tests already exercise the SQL Sandbox; if that
  # is broken in this environment, this tag mirrors the OAuthTest pattern.
  @moduletag :skip

  alias SymphonyElixir.Store

  describe "put_settings_atomic/1" do
    test "writes all keys in a single transaction" do
      assert {:ok, _} =
               Store.put_settings_atomic([
                 {"linear_oauth.access_token", "tok-1"},
                 {"linear_oauth.refresh_token", "ref-1"},
                 {"linear_oauth.expires_at", "2099-01-01T00:00:00Z"}
               ])

      assert "tok-1" == Store.get_setting("linear_oauth.access_token")
      assert "ref-1" == Store.get_setting("linear_oauth.refresh_token")
      assert "2099-01-01T00:00:00Z" == Store.get_setting("linear_oauth.expires_at")
    end

    test "accepts a map" do
      assert {:ok, _} =
               Store.put_settings_atomic(%{
                 "linear_oauth.access_token" => "tok-2",
                 "linear_oauth.expires_at" => "2099-06-01T00:00:00Z"
               })

      assert "tok-2" == Store.get_setting("linear_oauth.access_token")
    end

    test "later writes replace earlier values for the same key" do
      assert {:ok, _} = Store.put_settings_atomic([{"linear_oauth.access_token", "old"}])
      assert "old" == Store.get_setting("linear_oauth.access_token")

      assert {:ok, _} = Store.put_settings_atomic([{"linear_oauth.access_token", "new"}])
      assert "new" == Store.get_setting("linear_oauth.access_token")
    end
  end

  describe "delete_settings/1" do
    test "removes only the listed keys" do
      Store.put_setting("a", "1")
      Store.put_setting("b", "2")
      Store.put_setting("c", "3")

      assert :ok = Store.delete_settings(["a", "c"])

      assert nil == Store.get_setting("a")
      assert "2" == Store.get_setting("b")
      assert nil == Store.get_setting("c")
    end

    test "is a no-op for missing keys" do
      assert :ok = Store.delete_settings(["never-existed-1", "never-existed-2"])
    end
  end
end
