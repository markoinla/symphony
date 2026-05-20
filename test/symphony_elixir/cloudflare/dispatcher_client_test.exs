defmodule SymphonyElixir.Cloudflare.DispatcherClientTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Cloudflare.DispatcherClient

  describe "sign/2" do
    test "matches the Worker's HMAC-SHA256 hex encoding (lowercase)" do
      # Cross-checked against the same body+secret hashed by the
      # `computeSignature` helper in the sandbox-dispatcher Worker
      # (see the `markoinla/linear-agent` repo). The Worker uses
      # crypto.subtle.sign('HMAC', SHA-256)
      # and emits lowercase hex; this test pins our Erlang-side output
      # to the same bytes so the two halves of the system can talk to
      # each other.
      body = ~s({"scope":"alice"})
      secret = "test-secret-do-not-use-in-prod"

      assert DispatcherClient.sign(secret, body) ==
               "1628b1de2425d3d72af853cd72a18a7cdadda178157642d42411d70760b15b46"
    end

    test "signs an empty body too (used for GET requests)" do
      assert DispatcherClient.sign("k", "") =~ ~r/^[0-9a-f]{64}$/
    end
  end

  describe "base_url!/1 + hmac_secret!/1" do
    test "prefers explicit opts over env vars" do
      System.put_env("SYMPHONY_DISPATCHER_URL", "https://from-env.example/")
      System.put_env("SYMPHONY_DISPATCHER_HMAC_SECRET", "env-secret")

      on_exit(fn ->
        System.delete_env("SYMPHONY_DISPATCHER_URL")
        System.delete_env("SYMPHONY_DISPATCHER_HMAC_SECRET")
      end)

      assert DispatcherClient.base_url!(base_url: "https://from-opts.example") ==
               "https://from-opts.example"

      assert DispatcherClient.hmac_secret!(secret: "opts-secret") == "opts-secret"
    end

    test "falls back to env vars and trims trailing /" do
      System.put_env("SYMPHONY_DISPATCHER_URL", "https://from-env.example/")
      System.put_env("SYMPHONY_DISPATCHER_HMAC_SECRET", "env-secret")

      on_exit(fn ->
        System.delete_env("SYMPHONY_DISPATCHER_URL")
        System.delete_env("SYMPHONY_DISPATCHER_HMAC_SECRET")
      end)

      assert DispatcherClient.base_url!([]) == "https://from-env.example"
      assert DispatcherClient.hmac_secret!([]) == "env-secret"
    end

    test "raises when neither opts nor env are set" do
      System.delete_env("SYMPHONY_DISPATCHER_URL")
      System.delete_env("SYMPHONY_DISPATCHER_HMAC_SECRET")

      assert_raise RuntimeError, ~r/SYMPHONY_DISPATCHER_URL/, fn ->
        DispatcherClient.base_url!([])
      end

      assert_raise RuntimeError, ~r/SYMPHONY_DISPATCHER_HMAC_SECRET/, fn ->
        DispatcherClient.hmac_secret!([])
      end
    end
  end
end
