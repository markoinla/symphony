defmodule Mix.Tasks.Symphony.Baseline.Edit do
  use Mix.Task

  @shortdoc "Boot a one-shot sandbox-dispatcher PTY for editing an engine baseline"

  @moduledoc """
  Asks the `sandbox-dispatcher` Worker to spin up an edit sandbox for the
  given engine baseline, restore the current snapshot, start ttyd inside,
  and return a one-time PTY URL.

  Usage:

      mix symphony.baseline.edit --engine pi
      mix symphony.baseline.edit --engine codex
      mix symphony.baseline.edit --engine claude

  Options:

    * `--engine <name>`          Baseline engine to edit. One of:
                                 `pi`, `codex`, `claude`. Required.
    * `--dispatcher-url <url>`   Override the dispatcher base URL. Falls
                                 back to `SYMPHONY_DISPATCHER_URL`.
    * `--secret <hmac>`          Override the HMAC secret. Falls back to
                                 `SYMPHONY_DISPATCHER_HMAC_SECRET`.

  Workflow:

    1. Run this task and open the printed `pty_url` in a browser.
    2. In the PTY, edit the baseline: install tools, run CLI logins,
       update env files, etc. Changes land under `/home/symphony`.
    3. Persist the new snapshot:
         mix symphony.baseline.save --engine <same-engine>

  Each call tears down any prior `baseline-edit-<engine>` sandbox and
  starts a fresh one. The current baseline snapshot (if one exists) is
  restored into the sandbox first so you pick up where you left off.
  """

  alias SymphonyElixir.Cloudflare.DispatcherClient

  @impl Mix.Task
  def run(args) do
    {opts, _, invalid} =
      OptionParser.parse(args,
        strict: [
          engine: :string,
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
        edit(opts)
    end
  end

  defp edit(opts) do
    engine = opts[:engine]
    client_opts = [base_url: opts[:dispatcher_url], secret: opts[:secret], receive_timeout: 600_000]

    case DispatcherClient.post("/baselines/edit", %{engine: engine}, client_opts) do
      {:ok, %{status: 200, body: %{"pty_url" => pty_url} = body}} ->
        print_success(engine, pty_url, body)

      {:ok, %{status: status, body: body}} ->
        Mix.raise("Dispatcher returned HTTP #{status}: #{inspect(body)}")

      {:error, reason} ->
        Mix.raise("Dispatcher request failed: #{inspect(reason)}")
    end
  end

  defp print_success(engine, pty_url, body) do
    expires_at = body["expires_at"] || "unknown"
    had_prior = body["had_prior_baseline"] in [true, "true"]

    shell = Mix.shell()
    shell.info("")
    shell.info("Baseline edit sandbox ready for engine=#{engine}")
    shell.info("  pty_url:    #{pty_url}")
    shell.info("  expires at: #{expires_at}")

    if had_prior do
      shell.info("  prior baseline: restored into the sandbox")
    else
      shell.info("  prior baseline: none (starting from empty /home/symphony)")
    end

    shell.info("")
    shell.info("Open the pty_url in a browser and make your edits.")
    shell.info("")
    shell.info("When done, persist the new snapshot:")
    shell.info("  mix symphony.baseline.save --engine #{engine}")
    shell.info("")
  end
end
