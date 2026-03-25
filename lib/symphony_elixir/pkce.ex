defmodule SymphonyElixir.PKCE do
  @moduledoc """
  PKCE (Proof Key for Code Exchange) S256 utilities.

  Generates code verifier / code challenge pairs used to secure the OAuth token
  handoff between a Symphony instance and the proxy worker.
  """

  @verifier_bytes 32

  @type pair :: %{code_verifier: String.t(), code_challenge: String.t()}

  @spec generate() :: pair()
  def generate do
    code_verifier =
      @verifier_bytes
      |> :crypto.strong_rand_bytes()
      |> Base.url_encode64(padding: false)

    code_challenge =
      :crypto.hash(:sha256, code_verifier)
      |> Base.url_encode64(padding: false)

    %{code_verifier: code_verifier, code_challenge: code_challenge}
  end

  @spec verify(String.t(), String.t()) :: boolean()
  def verify(code_verifier, code_challenge) do
    computed =
      :crypto.hash(:sha256, code_verifier)
      |> Base.url_encode64(padding: false)

    computed == code_challenge
  end
end
