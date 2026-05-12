defmodule Mix.Tasks.Symphony.Baseline.Save do
  use Mix.Task

  @shortdoc "Snapshot the current edit sandbox into the engine baseline"

  @moduledoc """
  Asks the `sandbox-dispatcher` Worker to snapshot the live
  `baseline-edit-<engine>` sandbox (started by
  `mix symphony.baseline.edit`) into the `engine_baselines` D1 row,
  then destroy the sandbox.

  Usage:

      mix symphony.baseline.save --engine pi
      mix symphony.baseline.save --engine codex --version 1.2.3

  Options:

    * `--engine <name>`          Engine to snapshot. One of `pi`, `codex`,
                                 `claude`. Required.
    * `--version <tag>`          Optional version tag to record. If
                                 omitted, the existing tag (if any) is
                                 preserved.
    * `--dispatcher-url <url>`   Override the dispatcher base URL.
    * `--secret <hmac>`          Override the HMAC secret.

  The save call destroys the edit sandbox once the snapshot completes, so
  the PTY URL from the matching `baseline.edit` call becomes unreachable
  after this. To make further edits, run `baseline.edit` again — it will
  restore the snapshot you just saved.
  """

  alias SymphonyElixir.Cloudflare.DispatcherClient

  @impl Mix.Task
  def run(args) do
    {opts, _, invalid} =
      OptionParser.parse(args,
        strict: [
          engine: :string,
          version: :string,
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

      is_nil(opts[:engine]) ->
        Mix.raise("Missing required --engine (pi | codex | claude)")

      opts[:engine] not in ["pi", "codex", "claude"] ->
        Mix.raise("Invalid --engine #{inspect(opts[:engine])}. Must be one of: pi, codex, claude")

      true ->
        Mix.Task.run("app.config")
        Application.ensure_all_started(:req)
        save(opts)
    end
  end

  defp save(opts) do
    engine = opts[:engine]

    payload =
      %{engine: engine}
      |> maybe_put(:version, opts[:version])

    client_opts = [base_url: opts[:dispatcher_url], secret: opts[:secret], receive_timeout: 600_000]

    case DispatcherClient.post("/baselines/save", payload, client_opts) do
      {:ok, %{status: 200, body: body}} ->
        Mix.shell().info("Baseline saved for engine=#{engine}: " <> Jason.encode!(body))

      {:ok, %{status: status, body: body}} ->
        Mix.raise("Dispatcher returned HTTP #{status}: #{inspect(body)}")

      {:error, reason} ->
        Mix.raise("Dispatcher request failed: #{inspect(reason)}")
    end
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
