defmodule Mix.Tasks.Symphony.Auth.Bootstrap do
  use Mix.Task

  @shortdoc "Boot a one-shot sandbox-dispatcher PTY for interactive CLI logins"

  @moduledoc """
  Asks the `sandbox-dispatcher` Worker to spin up a bootstrap sandbox, start
  ttyd inside it, and return a one-time PTY URL.

  Usage:

      mix symphony.auth.bootstrap --scope alice
      mix symphony.auth.bootstrap --scope alice:proj-42

  Options:

    * `--scope <name>`           Snapshot scope. Required. Use a stable
                                 string (e.g. user id or `user:project`)
                                 since the same scope is reused by Phase 5
                                 to restore credentials into per-issue
                                 sandboxes.
    * `--dispatcher-url <url>`   Override the dispatcher base URL. Falls
                                 back to `SYMPHONY_DISPATCHER_URL`.
    * `--secret <hmac>`          Override the HMAC secret. Falls back to
                                 `SYMPHONY_DISPATCHER_HMAC_SECRET`.

  Workflow:

    1. Run this task and open the printed `pty_url` in a browser.
    2. In the PTY, log into each CLI you want Symphony agents to use:
         claude login
         codex auth login
         gh auth login
    3. Persist the snapshot:
         mix symphony.auth.snapshot --scope <same-scope>

  Each call to this task tears down any prior `bootstrap:<scope>` sandbox
  and starts a fresh one. If a snapshot already exists for the scope, it
  is restored into the sandbox first so you can extend an existing login
  set without redoing every CLI.
  """

  alias SymphonyElixir.Cloudflare.DispatcherClient

  @impl Mix.Task
  def run(args) do
    {opts, _, invalid} =
      OptionParser.parse(args,
        strict: [
          scope: :string,
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

      true ->
        Mix.Task.run("app.config")
        Application.ensure_all_started(:req)
        bootstrap(opts)
    end
  end

  defp bootstrap(opts) do
    scope = opts[:scope]
    client_opts = [base_url: opts[:dispatcher_url], secret: opts[:secret]]

    case DispatcherClient.post("/auth/bootstrap", %{scope: scope}, client_opts) do
      {:ok, %{status: 200, body: %{"pty_url" => pty_url} = body}} ->
        print_success(scope, pty_url, body)

      {:ok, %{status: status, body: body}} ->
        Mix.raise("Dispatcher returned HTTP #{status}: #{inspect(body)}")

      {:error, reason} ->
        Mix.raise("Dispatcher request failed: #{inspect(reason)}")
    end
  end

  defp print_success(scope, pty_url, body) do
    expires_at = body["expires_at"] || "unknown"
    had_prior = body["had_prior_snapshot"] in [true, "true"]

    shell = Mix.shell()
    shell.info("")
    shell.info("Bootstrap sandbox ready for scope=#{scope}")
    shell.info("  pty_url:    #{pty_url}")
    shell.info("  expires at: #{expires_at}")

    if had_prior do
      shell.info("  prior snapshot: restored into the sandbox")
    end

    shell.info("")
    shell.info("Open the pty_url in a browser, then inside the PTY run:")
    shell.info("  claude login")
    shell.info("  codex auth login")
    shell.info("  gh auth login")
    shell.info("")
    shell.info("When done, persist the snapshot:")
    shell.info("  mix symphony.auth.snapshot --scope #{scope}")
    shell.info("")
  end
end
