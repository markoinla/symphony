defmodule SymphonyElixirWeb.Plugs.LinearWebhookPlug do
  @moduledoc """
  Plug that verifies Linear webhook signatures using HMAC-SHA256.

  Reads the `Linear-Signature` header and verifies it against the
  configured `linear_agent.webhook_signing_secret`. If no secret is
  configured, the plug passes through (dev mode).
  """

  import Plug.Conn

  @behaviour Plug

  @impl true
  @spec init(keyword()) :: keyword()
  def init(opts), do: opts

  @impl true
  @spec call(Plug.Conn.t(), keyword()) :: Plug.Conn.t()
  def call(conn, _opts) do
    case get_signing_secret() do
      nil ->
        conn

      secret ->
        verify_signature(conn, secret)
    end
  end

  defp verify_signature(conn, secret) do
    raw_body = Map.get(conn.assigns, :raw_body, "")
    signature = get_req_header(conn, "linear-signature") |> List.first()

    if signature && valid_signature?(raw_body, secret, signature) do
      conn
    else
      conn
      |> put_resp_content_type("application/json")
      |> send_resp(401, Jason.encode!(%{error: %{code: "unauthorized", message: "Invalid webhook signature"}}))
      |> halt()
    end
  end

  defp valid_signature?(body, secret, signature) do
    expected = :crypto.mac(:hmac, :sha256, secret, body) |> Base.encode16(case: :lower)
    Plug.Crypto.secure_compare(expected, String.downcase(signature))
  end

  defp get_signing_secret do
    case SymphonyElixir.Config.settings!().linear_agent.webhook_signing_secret do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  rescue
    _ -> nil
  end
end
