defmodule SymphonyElixir.Linear.AuthTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Linear.Auth

  describe "resolve_auth_header/0" do
    test "returns Bearer prefix for OAuth token" do
      old = System.get_env("LINEAR_OAUTH_TOKEN")

      try do
        System.put_env("LINEAR_OAUTH_TOKEN", "oauth-test-token")

        assert {:ok, {"Authorization", value}} = Auth.resolve_auth_header()
        assert value == "Bearer oauth-test-token"
      after
        restore_env("LINEAR_OAUTH_TOKEN", old)
      end
    end

    test "returns Bearer prefix for API key" do
      old_oauth = System.get_env("LINEAR_OAUTH_TOKEN")

      try do
        System.delete_env("LINEAR_OAUTH_TOKEN")

        # The test setup writes a WORKFLOW.md with tracker api_key: "token"
        assert {:ok, {"Authorization", value}} = Auth.resolve_auth_header()
        assert value == "Bearer token"
      after
        restore_env("LINEAR_OAUTH_TOKEN", old_oauth)
      end
    end

    test "returns error when no auth is configured" do
      old_oauth = System.get_env("LINEAR_OAUTH_TOKEN")

      try do
        System.delete_env("LINEAR_OAUTH_TOKEN")

        # Write workflow with empty API key
        write_workflow_file!(
          SymphonyElixir.Workflow.workflow_file_path(),
          tracker_api_token: ""
        )

        assert {:error, :missing_linear_auth} = Auth.resolve_auth_header()
      after
        restore_env("LINEAR_OAUTH_TOKEN", old_oauth)
      end
    end

    test "prefers OAuth token over API key" do
      old_oauth = System.get_env("LINEAR_OAUTH_TOKEN")

      try do
        System.put_env("LINEAR_OAUTH_TOKEN", "my-oauth-token")

        # API key is also set via WORKFLOW.md ("token"), but OAuth should win
        assert {:ok, {"Authorization", value}} = Auth.resolve_auth_header()
        assert value == "Bearer my-oauth-token"
      after
        restore_env("LINEAR_OAUTH_TOKEN", old_oauth)
      end
    end
  end

  describe "has_auth?/0" do
    test "returns true when API key is configured" do
      old_oauth = System.get_env("LINEAR_OAUTH_TOKEN")

      try do
        System.delete_env("LINEAR_OAUTH_TOKEN")
        assert Auth.has_auth?()
      after
        restore_env("LINEAR_OAUTH_TOKEN", old_oauth)
      end
    end

    test "returns false when no auth is configured" do
      old_oauth = System.get_env("LINEAR_OAUTH_TOKEN")

      try do
        System.delete_env("LINEAR_OAUTH_TOKEN")

        write_workflow_file!(
          SymphonyElixir.Workflow.workflow_file_path(),
          tracker_api_token: ""
        )

        refute Auth.has_auth?()
      after
        restore_env("LINEAR_OAUTH_TOKEN", old_oauth)
      end
    end
  end
end
