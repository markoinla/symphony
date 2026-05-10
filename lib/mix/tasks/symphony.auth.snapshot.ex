defmodule Mix.Tasks.Symphony.Auth.Snapshot do
  use Mix.Task

  @shortdoc "Persist (or inspect/delete) the auth snapshot for a sandbox-dispatcher scope"

  @moduledoc """
  Talks to the `sandbox-dispatcher` Worker to manage the
  `DirectoryBackup` of `/home/node` for a snapshot scope.

  The most common use is to follow up a successful
  `mix symphony.auth.bootstrap --scope <name>` and persist the bootstrap
  sandbox's `/home/node` (auth tokens, ssh keys, gh config, etc.) as a
  reusable backup. The bootstrap sandbox is destroyed after the snapshot
  is captured.

  Usage:

      mix symphony.auth.snapshot --scope alice           # POST: capture + persist
      mix symphony.auth.snapshot --scope alice --check   # GET:  is one stored?
      mix symphony.auth.snapshot --scope alice --delete  # DELETE: forget the row

  Options:

    * `--scope <name>`           Snapshot scope. Required.
    * `--check`                  Don't capture; just report whether a
                                 snapshot is already stored.
    * `--delete`                 Don't capture; remove the stored handle.
                                 The R2 object is left to expire on the
                                 dispatcher's TTL.
    * `--dispatcher-url <url>`   Override the dispatcher base URL.
    * `--secret <hmac>`          Override the HMAC secret.
  """

  alias SymphonyElixir.Cloudflare.DispatcherClient

  @impl Mix.Task
  def run(args) do
    {opts, _, invalid} =
      OptionParser.parse(args,
        strict: [
          scope: :string,
          check: :boolean,
          delete: :boolean,
          dispatcher_url: :string,
          secret: :string,
          help: :boolean
        ],
        aliases: [h: :help]
      )

    cond do
      opts[:help] ->
        Mix.shell().info(@moduledoc)

      invalid != [] ->
        Mix.raise("Invalid option(s): #{inspect(invalid)}")

      is_nil(opts[:scope]) ->
        Mix.raise("Missing required --scope")

      opts[:check] and opts[:delete] ->
        Mix.raise("--check and --delete are mutually exclusive")

      true ->
        Mix.Task.run("app.config")
        Application.ensure_all_started(:req)
        dispatch(opts)
    end
  end

  defp dispatch(opts) do
    cond do
      opts[:check] -> check(opts)
      opts[:delete] -> delete(opts)
      true -> capture(opts)
    end
  end

  defp capture(opts) do
    scope = opts[:scope]
    client_opts = [base_url: opts[:dispatcher_url], secret: opts[:secret], receive_timeout: 600_000]

    case DispatcherClient.post("/auth/snapshot", %{scope: scope}, client_opts) do
      {:ok, %{status: 200, body: body}} ->
        Mix.shell().info("Snapshot stored for scope=#{scope}: " <> Jason.encode!(body))

      {:ok, %{status: status, body: body}} ->
        Mix.raise("Dispatcher returned HTTP #{status}: #{inspect(body)}")

      {:error, reason} ->
        Mix.raise("Dispatcher request failed: #{inspect(reason)}")
    end
  end

  defp check(opts) do
    scope = opts[:scope]
    client_opts = [base_url: opts[:dispatcher_url], secret: opts[:secret]]

    case DispatcherClient.get("/auth/snapshot", [scope: scope], client_opts) do
      {:ok, %{status: 200, body: body}} ->
        Mix.shell().info("Snapshot exists: " <> Jason.encode!(body))

      {:ok, %{status: 404, body: body}} ->
        Mix.shell().info("No snapshot stored for scope=#{scope}: " <> Jason.encode!(body))

      {:ok, %{status: status, body: body}} ->
        Mix.raise("Dispatcher returned HTTP #{status}: #{inspect(body)}")

      {:error, reason} ->
        Mix.raise("Dispatcher request failed: #{inspect(reason)}")
    end
  end

  defp delete(opts) do
    scope = opts[:scope]
    client_opts = [base_url: opts[:dispatcher_url], secret: opts[:secret]]

    case DispatcherClient.delete("/auth/snapshot", %{scope: scope}, client_opts) do
      {:ok, %{status: 200, body: body}} ->
        Mix.shell().info("Snapshot deleted for scope=#{scope}: " <> Jason.encode!(body))

      {:ok, %{status: status, body: body}} ->
        Mix.raise("Dispatcher returned HTTP #{status}: #{inspect(body)}")

      {:error, reason} ->
        Mix.raise("Dispatcher request failed: #{inspect(reason)}")
    end
  end
end
