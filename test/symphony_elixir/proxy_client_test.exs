defmodule SymphonyElixir.ProxyClientTest do
  use SymphonyElixir.DataCase, async: true

  alias SymphonyElixir.ProxyClient
  alias SymphonyElixir.Store

  setup do
    Store.put_setting("proxy.url", "http://localhost:8787")
    Store.put_setting("proxy.registration_secret", "test-secret-123")
    :ok
  end

  describe "start_oauth_flow/1" do
    test "returns a URL, state, and code_verifier for :linear" do
      {:ok, %{url: url, state: state, code_verifier: verifier}} =
        ProxyClient.start_oauth_flow(:linear)

      assert url =~ "http://localhost:8787/authorize?"
      assert url =~ "provider=linear"
      assert url =~ "state=#{URI.encode_www_form(state)}"
      assert url =~ "code_challenge="
      assert is_binary(state)
      assert is_binary(verifier)
    end

    test "returns a URL for :github" do
      {:ok, %{url: url}} = ProxyClient.start_oauth_flow(:github)
      assert url =~ "provider=github"
    end
  end

  describe "poll_token/2" do
    test "returns {:ok, tokens} on 200" do
      Req.Test.stub(SymphonyElixir.ProxyClient, fn conn ->
        Req.Test.json(conn, %{
          "access_token" => "lin_api_test123",
          "refresh_token" => "refresh_test456",
          "expires_at" => 1_711_324_800,
          "scope" => "read,write"
        })
      end)

      assert {:ok, tokens} = ProxyClient.poll_token("test-state", "test-verifier")
      assert tokens.access_token == "lin_api_test123"
      assert tokens.refresh_token == "refresh_test456"
      assert tokens.expires_at == 1_711_324_800
      assert tokens.scope == "read,write"
    end

    test "returns {:pending} on 202" do
      Req.Test.stub(SymphonyElixir.ProxyClient, fn conn ->
        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(202, Jason.encode!(%{"status" => "pending"}))
      end)

      assert {:pending} = ProxyClient.poll_token("test-state", "test-verifier")
    end

    test "returns {:expired} on 410" do
      Req.Test.stub(SymphonyElixir.ProxyClient, fn conn ->
        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(410, Jason.encode!(%{"error" => "expired"}))
      end)

      assert {:expired} = ProxyClient.poll_token("test-state", "test-verifier")
    end

    test "returns {:error, {:invalid_verifier, _}} on 401" do
      Req.Test.stub(SymphonyElixir.ProxyClient, fn conn ->
        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(401, Jason.encode!(%{"error" => "invalid code_verifier"}))
      end)

      assert {:error, {:invalid_verifier, _}} = ProxyClient.poll_token("test-state", "test-verifier")
    end
  end

  describe "register_instance/2" do
    test "returns :ok on 200" do
      Req.Test.stub(SymphonyElixir.ProxyClient, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn)
        parsed = Jason.decode!(body)
        assert parsed["instance_url"] == "http://100.64.1.1:4000"
        assert parsed["linear_org_id"] == "org-abc-123"

        assert Plug.Conn.get_req_header(conn, "authorization") == ["Bearer test-secret-123"]

        Req.Test.json(conn, %{"ok" => true, "linear_org_id" => "org-abc-123"})
      end)

      assert :ok = ProxyClient.register_instance("http://100.64.1.1:4000", "org-abc-123")
    end

    test "returns {:error, :unauthorized} on 401" do
      Req.Test.stub(SymphonyElixir.ProxyClient, fn conn ->
        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(401, Jason.encode!(%{"error" => "unauthorized"}))
      end)

      assert {:error, :unauthorized} = ProxyClient.register_instance("http://100.64.1.1:4000", "org-abc-123")
    end
  end
end
