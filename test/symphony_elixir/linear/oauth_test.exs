defmodule SymphonyElixir.Linear.OAuthTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Linear.OAuth
  alias SymphonyElixir.Store

  # Save and restore env vars around each test to avoid leaking state.
  setup do
    prev_client_id = System.get_env("LINEAR_OAUTH_CLIENT_ID")
    prev_client_secret = System.get_env("LINEAR_OAUTH_CLIENT_SECRET")

    System.delete_env("LINEAR_OAUTH_CLIENT_ID")
    System.delete_env("LINEAR_OAUTH_CLIENT_SECRET")

    on_exit(fn ->
      if prev_client_id, do: System.put_env("LINEAR_OAUTH_CLIENT_ID", prev_client_id)
      if prev_client_secret, do: System.put_env("LINEAR_OAUTH_CLIENT_SECRET", prev_client_secret)

      Store.delete_setting("linear_oauth.client_id")
      Store.delete_setting("linear_oauth.client_secret")
    end)

    :ok
  end

  describe "credentials_source/0" do
    test "returns :none when no credentials are configured" do
      assert :none == OAuth.credentials_source()
    end

    test "returns :env when only env vars are set" do
      System.put_env("LINEAR_OAUTH_CLIENT_ID", "env-client-id")

      assert :env == OAuth.credentials_source()
    end

    test "returns :store when settings store has credentials" do
      {:ok, _} = Store.put_setting("linear_oauth.client_id", "store-client-id")

      assert :store == OAuth.credentials_source()
    end

    test "returns :store when both store and env are set (store takes priority)" do
      {:ok, _} = Store.put_setting("linear_oauth.client_id", "store-client-id")
      System.put_env("LINEAR_OAUTH_CLIENT_ID", "env-client-id")

      assert :store == OAuth.credentials_source()
    end
  end

  describe "authorize_url/2 env var fallback" do
    test "returns error when no client_id is available" do
      assert {:error, :missing_client_id} = OAuth.authorize_url("state123", "http://localhost/callback")
    end

    test "uses env var client_id when store is empty" do
      System.put_env("LINEAR_OAUTH_CLIENT_ID", "env-client-id")

      assert {:ok, url} = OAuth.authorize_url("state123", "http://localhost/callback")
      assert url =~ "client_id=env-client-id"
    end

    test "prefers store client_id over env var" do
      {:ok, _} = Store.put_setting("linear_oauth.client_id", "store-client-id")
      System.put_env("LINEAR_OAUTH_CLIENT_ID", "env-client-id")

      assert {:ok, url} = OAuth.authorize_url("state123", "http://localhost/callback")
      assert url =~ "client_id=store-client-id"
    end
  end

  describe "exchange_code/2 env var fallback" do
    test "returns error when no credentials are available" do
      assert {:error, :missing_credentials} = OAuth.exchange_code("code123", "http://localhost/callback")
    end

    test "returns error when only client_id env var is set (missing secret)" do
      System.put_env("LINEAR_OAUTH_CLIENT_ID", "env-client-id")

      assert {:error, :missing_credentials} = OAuth.exchange_code("code123", "http://localhost/callback")
    end
  end
end
