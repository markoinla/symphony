defmodule SymphonyElixir.Cloudflare.DispatcherClient do
  @moduledoc """
  HTTP client for the `sandbox-dispatcher` Cloudflare Worker.

  Used by the `mix symphony.baseline.edit` / `mix symphony.baseline.save`
  tasks today; Phase 5 reuses it for `Worker.Backend.CloudflareSandbox`'s
  `acquire`/`exec`/`release` calls.

  Every request is HMAC-SHA256 signed over the raw body using the
  `DISPATCH_HMAC_SECRET` shared with the Worker (verified by the
  `computeSignature` helper in the `sandbox-dispatcher` Worker — see
  the `markoinla/linear-agent` repo). The signature is sent as
  lowercase hex in the `X-Symphony-Signature` header.

  Configuration is sourced from the environment so the tasks work without
  pulling Symphony's full runtime stack:

    * `SYMPHONY_DISPATCHER_URL` — base URL of the deployed Worker
      (e.g. `https://sandbox-dispatcher.<account>.workers.dev`)
    * `SYMPHONY_DISPATCHER_HMAC_SECRET` — shared secret matching the
      Worker's `DISPATCH_HMAC_SECRET`
  """

  @signature_header "X-Symphony-Signature"

  @type opts :: [base_url: String.t(), secret: String.t(), receive_timeout: pos_integer()]
  @type response :: %{status: pos_integer(), body: term()}

  @spec post(String.t(), map(), opts()) :: {:ok, response()} | {:error, term()}
  def post(path, body, opts \\ []) when is_binary(path) and is_map(body) do
    request(:post, path, body, opts)
  end

  @spec get(String.t(), keyword(), opts()) :: {:ok, response()} | {:error, term()}
  def get(path, query \\ [], opts \\ []) when is_binary(path) and is_list(query) do
    request(:get, path, %{}, Keyword.put(opts, :query, query))
  end

  @spec delete(String.t(), map(), opts()) :: {:ok, response()} | {:error, term()}
  def delete(path, body, opts \\ []) when is_binary(path) and is_map(body) do
    request(:delete, path, body, opts)
  end

  @spec base_url!(opts()) :: String.t()
  def base_url!(opts) do
    case Keyword.get(opts, :base_url) || System.get_env("SYMPHONY_DISPATCHER_URL") do
      url when is_binary(url) and url != "" -> String.trim_trailing(url, "/")
      _ -> raise "SYMPHONY_DISPATCHER_URL not set (pass --dispatcher-url or export the env var)"
    end
  end

  @spec hmac_secret!(opts()) :: String.t()
  def hmac_secret!(opts) do
    case Keyword.get(opts, :secret) || System.get_env("SYMPHONY_DISPATCHER_HMAC_SECRET") do
      secret when is_binary(secret) and secret != "" -> secret
      _ -> raise "SYMPHONY_DISPATCHER_HMAC_SECRET not set"
    end
  end

  @spec sign(String.t(), iodata()) :: String.t()
  def sign(secret, body) when is_binary(secret) do
    body_bin = IO.iodata_to_binary(body)
    :crypto.mac(:hmac, :sha256, secret, body_bin) |> Base.encode16(case: :lower)
  end

  defp request(method, path, body, opts) do
    base_url = base_url!(opts)
    secret = hmac_secret!(opts)
    receive_timeout = Keyword.get(opts, :receive_timeout, 60_000)

    body_iodata =
      cond do
        method == :get -> ""
        body == %{} and method == :delete -> ""
        true -> Jason.encode!(body)
      end

    signature = sign(secret, body_iodata)
    url = base_url <> path

    req =
      [
        method: method,
        url: url,
        headers: [
          {"content-type", "application/json"},
          {@signature_header, signature}
        ],
        receive_timeout: receive_timeout
      ]
      |> maybe_put_body(method, body_iodata)
      |> maybe_put_query(opts[:query])

    case Req.request(req) do
      {:ok, %Req.Response{status: status, body: body}} ->
        {:ok, %{status: status, body: body}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp maybe_put_body(req_opts, :get, _), do: req_opts

  defp maybe_put_body(req_opts, _method, ""), do: req_opts

  defp maybe_put_body(req_opts, _method, body_iodata) do
    Keyword.put(req_opts, :body, body_iodata)
  end

  defp maybe_put_query(req_opts, nil), do: req_opts
  defp maybe_put_query(req_opts, []), do: req_opts
  defp maybe_put_query(req_opts, query), do: Keyword.put(req_opts, :params, query)
end
