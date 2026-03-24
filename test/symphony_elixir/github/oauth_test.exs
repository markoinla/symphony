defmodule SymphonyElixir.GitHub.OAuthTest do
  use SymphonyElixir.TestSupport
  # TODO: fix DB connection ownership in setup/teardown
  @moduletag :skip

  alias SymphonyElixir.GitHub.OAuth
  alias SymphonyElixir.Store

  # Save and restore env vars around each test to avoid leaking state.
  setup do
    prev_client_id = System.get_env("GITHUB_OAUTH_CLIENT_ID")
    prev_client_secret = System.get_env("GITHUB_OAUTH_CLIENT_SECRET")

    System.delete_env("GITHUB_OAUTH_CLIENT_ID")
    System.delete_env("GITHUB_OAUTH_CLIENT_SECRET")

    prev_store_client_id = Store.get_setting("github_oauth.client_id")
    prev_store_client_secret = Store.get_setting("github_oauth.client_secret")
    Store.delete_setting("github_oauth.client_id")
    Store.delete_setting("github_oauth.client_secret")

    on_exit(fn ->
      if prev_store_client_id, do: Store.put_setting("github_oauth.client_id", prev_store_client_id)
      if prev_store_client_secret, do: Store.put_setting("github_oauth.client_secret", prev_store_client_secret)
      if prev_client_id, do: System.put_env("GITHUB_OAUTH_CLIENT_ID", prev_client_id)
      if prev_client_secret, do: System.put_env("GITHUB_OAUTH_CLIENT_SECRET", prev_client_secret)

      Store.delete_setting("github_oauth.client_id")
      Store.delete_setting("github_oauth.client_secret")
    end)

    :ok
  end

  describe "credentials_source/0" do
    test "returns :none when no credentials are configured" do
      assert :none == OAuth.credentials_source()
    end

    test "returns :env when both env vars are set" do
      System.put_env("GITHUB_OAUTH_CLIENT_ID", "env-client-id")
      System.put_env("GITHUB_OAUTH_CLIENT_SECRET", "env-client-secret")

      assert :env == OAuth.credentials_source()
    end

    test "returns :none when only client_id env var is set (incomplete pair)" do
      System.put_env("GITHUB_OAUTH_CLIENT_ID", "env-client-id")

      assert :none == OAuth.credentials_source()
    end

    test "returns :none when env vars are empty strings" do
      System.put_env("GITHUB_OAUTH_CLIENT_ID", "")
      System.put_env("GITHUB_OAUTH_CLIENT_SECRET", "")

      assert :none == OAuth.credentials_source()
    end

    test "returns :store when settings store has credentials" do
      {:ok, _} = Store.put_setting("github_oauth.client_id", "store-client-id")

      assert :store == OAuth.credentials_source()
    end

    test "returns :store when both store and env are set (store takes priority)" do
      {:ok, _} = Store.put_setting("github_oauth.client_id", "store-client-id")
      System.put_env("GITHUB_OAUTH_CLIENT_ID", "env-client-id")

      assert :store == OAuth.credentials_source()
    end
  end

  describe "authorize_url/2" do
    test "returns error when no client_id is available" do
      assert {:error, :missing_client_id} = OAuth.authorize_url("state123", "http://localhost/callback")
    end

    test "uses env var client_id when store is empty" do
      System.put_env("GITHUB_OAUTH_CLIENT_ID", "env-client-id")

      assert {:ok, url} = OAuth.authorize_url("state123", "http://localhost/callback")
      assert url =~ "client_id=env-client-id"
      assert url =~ "github.com/login/oauth/authorize"
      assert url =~ "scope=repo"
    end

    test "prefers store client_id over env var" do
      {:ok, _} = Store.put_setting("github_oauth.client_id", "store-client-id")
      System.put_env("GITHUB_OAUTH_CLIENT_ID", "env-client-id")

      assert {:ok, url} = OAuth.authorize_url("state123", "http://localhost/callback")
      assert url =~ "client_id=store-client-id"
    end
  end

  describe "exchange_code/2" do
    test "returns error when no credentials are available" do
      assert {:error, :missing_credentials} = OAuth.exchange_code("code123", "http://localhost/callback")
    end

    test "returns error when only client_id env var is set (missing secret)" do
      System.put_env("GITHUB_OAUTH_CLIENT_ID", "env-client-id")

      assert {:error, :missing_credentials} = OAuth.exchange_code("code123", "http://localhost/callback")
    end
  end

  describe "connection_status/0" do
    test "returns :disconnected when no token is stored and no env var" do
      assert {:disconnected, nil} = OAuth.connection_status()
    end

    test "returns :connected when access token is stored" do
      {:ok, _} = Store.put_setting("github_oauth.access_token", "gho_testtoken")
      on_exit(fn -> Store.delete_setting("github_oauth.access_token") end)

      assert {:connected, nil} = OAuth.connection_status()
    end

    test "returns :connected with expires_at when token and expiry are stored" do
      future = DateTime.utc_now() |> DateTime.add(3600, :second) |> DateTime.to_iso8601()
      {:ok, _} = Store.put_setting("github_oauth.access_token", "gho_testtoken")
      {:ok, _} = Store.put_setting("github_oauth.expires_at", future)

      on_exit(fn ->
        Store.delete_setting("github_oauth.access_token")
        Store.delete_setting("github_oauth.expires_at")
      end)

      assert {:connected, ^future} = OAuth.connection_status()
    end

    test "returns :expired when token is stored but expired" do
      past = DateTime.utc_now() |> DateTime.add(-3600, :second) |> DateTime.to_iso8601()
      {:ok, _} = Store.put_setting("github_oauth.access_token", "gho_testtoken")
      {:ok, _} = Store.put_setting("github_oauth.expires_at", past)

      on_exit(fn ->
        Store.delete_setting("github_oauth.access_token")
        Store.delete_setting("github_oauth.expires_at")
      end)

      assert {:expired, ^past} = OAuth.connection_status()
    end
  end

  describe "revoke/0" do
    test "deletes all OAuth settings" do
      {:ok, _} = Store.put_setting("github_oauth.access_token", "gho_testtoken")
      {:ok, _} = Store.put_setting("github_oauth.refresh_token", "ghr_testtoken")
      {:ok, _} = Store.put_setting("github_oauth.expires_at", "2026-01-01T00:00:00Z")
      {:ok, _} = Store.put_setting("github_oauth.state", "random_state")

      assert :ok = OAuth.revoke()

      assert nil == Store.get_setting("github_oauth.access_token")
      assert nil == Store.get_setting("github_oauth.refresh_token")
      assert nil == Store.get_setting("github_oauth.expires_at")
      assert nil == Store.get_setting("github_oauth.state")
    end
  end

  describe "store_state/1 and validate_state/1" do
    test "stores and validates state" do
      :ok = OAuth.store_state("test-state-123")

      assert :ok = OAuth.validate_state("test-state-123")
      # State is deleted after validation
      assert {:error, :invalid_state} = OAuth.validate_state("test-state-123")
    end

    test "returns error for mismatched state" do
      :ok = OAuth.store_state("test-state-123")

      assert {:error, :invalid_state} = OAuth.validate_state("wrong-state")

      # Clean up
      Store.delete_setting("github_oauth.state")
    end
  end
end
