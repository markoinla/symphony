defmodule SymphonyElixir.PKCETest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.PKCE

  describe "generate/0" do
    test "returns a code_verifier of at least 43 characters" do
      %{code_verifier: verifier} = PKCE.generate()
      assert String.length(verifier) >= 43
    end

    test "code_verifier is valid base64url (no padding)" do
      %{code_verifier: verifier} = PKCE.generate()
      assert verifier =~ ~r/^[A-Za-z0-9_-]+$/
    end

    test "code_challenge is valid base64url (no padding)" do
      %{code_challenge: challenge} = PKCE.generate()
      assert challenge =~ ~r/^[A-Za-z0-9_-]+$/
    end

    test "code_challenge is SHA256 of code_verifier" do
      %{code_verifier: verifier, code_challenge: challenge} = PKCE.generate()

      expected =
        :crypto.hash(:sha256, verifier)
        |> Base.url_encode64(padding: false)

      assert challenge == expected
    end

    test "generates unique pairs on each call" do
      pair1 = PKCE.generate()
      pair2 = PKCE.generate()
      assert pair1.code_verifier != pair2.code_verifier
      assert pair1.code_challenge != pair2.code_challenge
    end
  end

  describe "verify/2" do
    test "returns true for matching verifier and challenge" do
      %{code_verifier: verifier, code_challenge: challenge} = PKCE.generate()
      assert PKCE.verify(verifier, challenge)
    end

    test "returns false for wrong verifier" do
      %{code_challenge: challenge} = PKCE.generate()
      refute PKCE.verify("wrong-verifier", challenge)
    end
  end
end
