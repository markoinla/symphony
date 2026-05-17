import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";

import type { Env } from "./index";
import { BaselineStore } from "./storage";
import { resolveBaselineEngine } from "./baseline-alias";
import {
  SANDBOX_HOME,
  getProcessLogsOrNull,
  getProcessOrNull,
  safeDestroy,
  sanitizeScopeForId,
} from "./sandbox-helpers";
import { computeSignature } from "./hmac";
import {
  ENGINE_CMD_PATH,
  FORWARDER_PATH,
  FORWARDER_SCRIPT,
  INGEST_CONFIG_PATH,
  type IngestConfig,
} from "./forwarder";
import { createClaudeEngineAdapter } from "./engines/claude";
import { piEngineAdapter } from "./engines/pi";
import type { EngineAdapter, NormalizedEvent } from "./engines/types";

/**
 * `/run` — execute one agent turn in a fresh per-issue sandbox.
 *
 * Buffered flow (non-streaming `/run`):
 *   1. Look up the baseline snapshot for `engine`. 412 if absent.
 *   2. Get a per-run sandbox (`run-<sanitized-run-id>`), restore the
 *      baseline so engine binary + base toolchain are available.
 *   3. Clone `repo_url` into `/workspace/<issue_id>`.
 *   4. Inject per-tenant credentials (env vars, MCP config) from the
 *      `credentials` block.
 *   5. Build an engine command and exec it with the configured timeout.
 *   6. Always destroy the sandbox in `finally`.
 *
 * Streaming flow (`Accept: text/event-stream`) is different: the engine
 * runs as a *detached background process* and the sandbox is NOT
 * destroyed when the SSE reader disconnects — see `runStreaming`. It is
 * torn down only via `POST /run/stop`.
 *
 * Returns `{ engine, exit_code, stdout, stderr, duration_ms }` on success.
 *
 * Baselines contain only binaries (no credentials). Per-tenant secrets
 * arrive via the `credentials` block on each `/run` request.
 */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

// Poll cadence for tailing a detached engine process's log. Starts at
// POLL_MIN_MS and backs off toward POLL_MAX_MS while no new output
// arrives, resetting to the floor whenever the engine emits again.
const POLL_MIN_MS = 2000;
const POLL_MAX_MS = 5000;

// Prefix marking a dispatcher-injected prelude event line in the engine
// process's stdout (setup narration). See `buildPreludeCommand`.
const PRELUDE_PREFIX = "__SYMPHONY_EVENT__ ";

const SUPPORTED_ENGINES = new Set(["pi", "claude"] as const);
type Engine = "pi" | "claude";

interface RunBody {
  issue_id?: unknown;
  repo_url?: unknown;
  prompt?: unknown;
  engine?: unknown;
  model?: unknown;
  timeout_ms?: unknown;
  max_turns?: unknown;
  permission_mode?: unknown;
  append_system_prompt?: unknown;
  allowed_tools?: unknown;
  disallowed_tools?: unknown;
  github_token?: unknown;
  credentials?: unknown;
  // Optional branch name. When set, after clone the dispatcher fetches
  // the branch from origin if it exists, otherwise creates it locally
  // from the default branch HEAD. Unset = current behavior (work on
  // the default branch). See `resolveBranch` for the logic.
  branch?: unknown;
  // Current turn number (1-based). Per-turn engine processes are keyed
  // by this so a multi-turn session's turns don't collide; defaults to 1.
  turn?: unknown;
  // Caller-stable run identifier. The sandbox and engine process are
  // namespaced by this, so two distinct agent sessions on the *same*
  // issue (e.g. a Triage run then an implementation run) get isolated
  // sandboxes instead of the second one re-attaching to the first's
  // leftover process. Defaults to `issue_id` when absent — fine for
  // one-shot callers (buffered `/run`, smoke tests) that have no
  // session concept.
  run_id?: unknown;
  // `/run/start` only (engine-push, SYM-386). Base URL of the
  // linear-agent worker; the forwarder POSTs run events to
  // `<ingest_url>/internal/run-events/<run_id>`.
  ingest_url?: unknown;
  // `/run/start` only. Workflow instance id the ingest endpoint wakes
  // when the run finishes. Usually equals `run_id`, but differs for
  // `:rN` resume instances — so it is threaded explicitly.
  instance_id?: unknown;
}

interface CredentialsBody {
  cloudflare_account_id?: unknown;
  cloudflare_api_token?: unknown;
  anthropic_api_key?: unknown;
  openai_api_key?: unknown;
  github_token?: unknown;
  linear_token?: unknown;
  mcp_servers?: unknown;
}

interface McpServerBody {
  name?: unknown;
  url?: unknown;
  token?: unknown;
}

export interface ParsedCredentials {
  envVars: Array<{ name: string; value: string }>;
  mcpServers: Array<{ name: string; url: string; token: string }>;
}

interface ParsedRun {
  issueId: string;
  // Run-scope key for the sandbox + engine process. Defaults to
  // `issueId` when the caller omits `run_id`.
  runId: string;
  repoUrl: string;
  prompt: string;
  engine: Engine;
  model: string | null;
  permissionMode: string | null;
  appendSystemPrompt: string | null;
  allowedTools: string[] | null;
  disallowedTools: string[] | null;
  timeoutMs: number;
  githubToken: string | null;
  credentials: ParsedCredentials | null;
  branch: string | null;
  turn: number;
  // `/run/start` push-path fields. Null for buffered `/run` and the SSE
  // path, which don't use them.
  ingestUrl: string | null;
  instanceId: string | null;
}

export function buildRunRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/run", async (c) => {
    const body = await readJsonBody<RunBody>(c.req.raw);
    const parsed = parseRun(body);
    if (typeof parsed === "string") {
      return c.json({ error: parsed }, 400);
    }

    // Streaming branch: the linear-agent Worker sets
    // `Accept: text/event-stream` to receive normalized events as they
    // happen (item 2 of SYM-267). Streaming requests are always 200 +
    // SSE; the snapshot precondition and any other failure surfaces as
    // an `error` event followed by a non-zero `result`. The legacy
    // buffered path below keeps the existing 4xx semantics so
    // non-streaming callers (smoke tests, the Elixir client) don't
    // break.
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/event-stream")) {
      return runStreaming(c.env, parsed);
    }

    const store = new BaselineStore(c.env.DB);
    const baselineEngine = resolveBaselineEngine(parsed.engine);
    const record = await store.get(baselineEngine);
    if (!record) {
      return c.json(
        {
          error: "missing_baseline",
          engine: parsed.engine,
          ...(baselineEngine !== parsed.engine
            ? { baseline_engine: baselineEngine }
            : {}),
        },
        412,
      );
    }

    const sandbox = getSandbox(c.env.Sandbox, runSandboxId(parsed.runId));
    const startedAt = Date.now();

    try {
      await sandbox.restoreBackup(record.handle);

      const workspaceDir = `/workspace/${parsed.issueId}`;
      await sandbox.exec(`mkdir -p ${shellQuote(workspaceDir)}`);

      // Best-effort clean clone: if the dir already had something, blow it
      // away so `git clone` doesn't fail. Per-run sandbox ID means this is
      // only nonempty if a previous /run for the same run raced or failed
      // mid-flight.
      await sandbox.exec(
        `rm -rf ${shellQuote(workspaceDir)} && mkdir -p ${shellQuote(workspaceDir)}`,
      );

      const cloneToken = parsed.githubToken ?? c.env.DISPATCH_GITHUB_TOKEN;
      const cloneUrl = buildAuthenticatedCloneUrl(parsed.repoUrl, cloneToken);
      const cloneResult = await sandbox.exec(
        `cd ${shellQuote(workspaceDir)} && git clone ${shellQuote(cloneUrl)} .`,
      );
      if (cloneResult.exitCode !== 0) {
        return c.json(
          {
            error: "clone_failed",
            exit_code: cloneResult.exitCode,
            stderr: redactToken(cloneResult.stderr, cloneToken),
          },
          502,
        );
      }

      let resolvedBranch: string | null = null;
      if (parsed.branch) {
        const branchResult = await resolveBranch(sandbox, workspaceDir, parsed.branch);
        if (!branchResult.ok) {
          return c.json(
            {
              error: "branch_setup_failed",
              exit_code: branchResult.exitCode,
              stderr: branchResult.stderr,
            },
            502,
          );
        }
        resolvedBranch = parsed.branch;
      }

      if (parsed.credentials) {
        try {
          await writeMcpConfig(sandbox, workspaceDir, parsed.engine, parsed.credentials);
        } catch (e) {
          return c.json(
            {
              error: "mcp_config_write_failed",
              exit_code: 1,
              stderr: e instanceof Error ? e.message : String(e),
            },
            502,
          );
        }
      }

      const cmd = buildEngineCommand(parsed, workspaceDir);
      const result = await sandbox.exec(cmd, { timeout: parsed.timeoutMs });

      return c.json({
        engine: parsed.engine,
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: Date.now() - startedAt,
        branch: resolvedBranch,
        commit_sha: null,
        push_error: null,
      });
    } finally {
      await safeDestroy(sandbox);
    }
  });

  app.post("/run/stop", async (c) => {
    const body = await readJsonBody<{ issue_id?: unknown; run_id?: unknown }>(
      c.req.raw,
    );
    // `run_id` is the sandbox key; `issue_id` is the historical key and
    // still accepted (Elixir client, smoke tests). Either identifies the
    // sandbox — at least one must be present.
    const runId = parseIssueId(body.run_id) ?? parseIssueId(body.issue_id);
    if (!runId) {
      return c.json({ error: "invalid_run_id" }, 400);
    }
    const sandbox = getSandbox(c.env.Sandbox, runSandboxId(runId));
    await safeDestroy(sandbox);
    return c.json({ ok: true, run_id: runId });
  });

  // `/run/start` — engine-push start (SYM-386). Runs the same setup as
  // `/run` (baseline restore, clone, branch, MCP config) but then
  // launches the sandbox *forwarder* as a detached process and returns
  // immediately. The forwarder POSTs engine events straight to the
  // linear-agent ingest endpoint, so the dispatcher holds nothing open
  // — no SSE, no re-attach. The caller's Workflow parks on
  // `step.waitForEvent` until the forwarder's terminal batch wakes it.
  //
  // pi only: claude still uses the SSE `/run` path.
  app.post("/run/start", async (c) => {
    const body = await readJsonBody<RunBody>(c.req.raw);
    const parsed = parseRun(body);
    if (typeof parsed === "string") {
      return c.json({ error: parsed }, 400);
    }
    if (parsed.engine !== "pi") {
      return c.json(
        { error: "engine_not_supported_for_start", engine: parsed.engine },
        400,
      );
    }
    if (!parsed.ingestUrl) return c.json({ error: "missing_ingest_url" }, 400);
    if (!parsed.instanceId) {
      return c.json({ error: "missing_instance_id" }, 400);
    }

    const sandbox = getSandbox(c.env.Sandbox, runSandboxId(parsed.runId));
    const processId = runProcessId(parsed.runId, parsed.turn);

    // Idempotent re-entry. A retried `startRun` step lands back here; if
    // the forwarder process already exists the run is in flight, so
    // skip setup — re-running it would `rm -rf` the workspace out from
    // under the live engine.
    const existing = await getProcessOrNull(sandbox, processId);
    if (existing) {
      return c.json({ ok: true, run_id: parsed.runId, already_running: true });
    }

    const prep = await prepareWorkspace(c.env, sandbox, parsed);
    if (!prep.ok) {
      return c.json(prep.body, prep.status);
    }

    // The sandbox only ever holds a per-run token, never the master
    // secret: token = HMAC(DISPATCH_HMAC_SECRET, run_id). The ingest
    // endpoint recomputes it from the run id in its URL path.
    const token = await computeSignature(
      c.env.DISPATCH_HMAC_SECRET,
      parsed.runId,
    );
    const ingestConfig: IngestConfig = {
      url:
        `${parsed.ingestUrl.replace(/\/+$/, "")}` +
        `/internal/run-events/${encodeURIComponent(parsed.runId)}`,
      token,
      instanceId: parsed.instanceId,
    };

    try {
      await writeForwarderFiles(
        sandbox,
        buildEngineCommand(parsed, prep.workspaceDir),
        ingestConfig,
      );
    } catch (e) {
      return c.json(
        {
          error: "forwarder_write_failed",
          stderr: e instanceof Error ? e.message : String(e),
        },
        502,
      );
    }

    await sandbox.startProcess(forwarderStartCommand(), {
      processId,
      // Keep the process record + logs after exit so a late retry of
      // the caller's `startRun` step still observes `already_running`.
      autoCleanup: false,
      timeout: parsed.timeoutMs,
    });

    return c.json({ ok: true, run_id: parsed.runId });
  });

  // Re-attach to an in-flight (or already-finished) engine process for
  // an issue/turn and resume the SSE stream from `cursor` — the number
  // of normalized events the caller already consumed. This is how the
  // linear-agent worker recovers when its Workflow step is evicted
  // mid-turn: the engine kept running as a detached process, so the
  // retry re-attaches here instead of re-dispatching a fresh run.
  app.post("/run/attach", async (c) => {
    const body = await readJsonBody<{
      issue_id?: unknown;
      run_id?: unknown;
      turn?: unknown;
      cursor?: unknown;
      engine?: unknown;
    }>(c.req.raw);

    const issueId = parseIssueId(body.issue_id);
    if (!issueId) {
      return c.json({ error: "invalid_issue_id" }, 400);
    }
    if (
      typeof body.engine !== "string" ||
      !SUPPORTED_ENGINES.has(body.engine as Engine)
    ) {
      return c.json({ error: "unsupported_engine" }, 400);
    }
    const engine = body.engine as Engine;
    const turn = parseTurn(body.turn);
    const cursor = parseCursor(body.cursor);

    // Must match the `run_id` the original `/run` used, or the
    // re-attach derives a different sandbox/process and finds nothing.
    const runId = parseIssueId(body.run_id) ?? issueId;
    const sandbox = getSandbox(c.env.Sandbox, runSandboxId(runId));
    const processId = runProcessId(runId, turn);

    return streamRun({
      sandbox,
      adapter: adapterFor(engine),
      cursor,
      start: async () => {
        const proc = await getProcessOrNull(sandbox, processId);
        if (!proc) {
          return { ok: false, message: "process_not_found" };
        }
        return { ok: true, processId };
      },
    });
  });

  return app;
}

/**
 * Sandbox id for a run. Keyed by `runId` (the caller's per-session run
 * identifier, falling back to `issue_id`) so two agent sessions on the
 * same issue get isolated sandboxes.
 */
export function runSandboxId(runId: string): string {
  return `run-${sanitizeScopeForId(runId)}`;
}

/**
 * Streaming branch of `/run`. Setup (snapshot restore, clone, branch,
 * MCP config) runs as before, but the engine is then launched as a
 * *detached background process* (`sandbox.startProcess`) that writes
 * its own stdout to the process log. The HTTP response only ever
 * *tails* that log — see `streamRun`.
 *
 * Why detached: a Cloudflare Workflows step on the caller side
 * (linear-agent's `turn-N`) gets evicted with `WorkflowInternalError`
 * roughly every ~5 minutes. When that happens the SSE reader
 * disconnects. If the engine were tied to this request it would die
 * with it; as a background process it keeps running, and the caller
 * re-attaches via `POST /run/attach` from the last cursor.
 *
 * Setup narration ("Cloning…", "Calling model…") is echoed by the
 * process itself as `__SYMPHONY_EVENT__`-prefixed prelude lines, so
 * those events live in the same durable log and a re-attach replays
 * them deterministically rather than the dispatcher having to
 * reproduce request-scoped state.
 */
function runStreaming(env: Env, parsed: ParsedRun): Response {
  const sandbox = getSandbox(env.Sandbox, runSandboxId(parsed.runId));
  const processId = runProcessId(parsed.runId, parsed.turn);

  return streamRun({
    sandbox,
    adapter: adapterFor(parsed.engine),
    // A fresh /run always starts from the beginning of the event
    // stream; re-attach (/run/attach) is the path that carries a
    // non-zero cursor.
    cursor: 0,
    start: async () => {
      // Idempotent re-entry. If a caller's turn step was evicted after
      // the engine process started but before any event was persisted,
      // its retry lands back on /run with cursor 0. Attaching to the
      // existing process is mandatory here: re-running setup would
      // `rm -rf` the workspace out from under the live engine and
      // `startProcess` would collide on the same processId.
      const existing = await getProcessOrNull(sandbox, processId);
      if (existing) return { ok: true, processId };

      // Setup narration is collected, not streamed: it's echoed by the
      // engine process as prelude lines so it survives a re-attach.
      const preludeThoughts: string[] = ["Spinning up a sandbox…"];

      const baselineEngine = resolveBaselineEngine(parsed.engine);
      const record = await new BaselineStore(env.DB).get(baselineEngine);
      if (!record) {
        const message =
          baselineEngine === parsed.engine
            ? `missing_baseline: ${parsed.engine}`
            : `missing_baseline: ${baselineEngine} (engine ${parsed.engine})`;
        return { ok: false, message };
      }

      preludeThoughts.push("Configuring environment…");
      await sandbox.restoreBackup(record.handle);

      const workspaceDir = `/workspace/${parsed.issueId}`;
      await sandbox.exec(`mkdir -p ${shellQuote(workspaceDir)}`);
      await sandbox.exec(
        `rm -rf ${shellQuote(workspaceDir)} && mkdir -p ${shellQuote(workspaceDir)}`,
      );

      preludeThoughts.push(`Cloning ${redactRepoUrl(parsed.repoUrl)}…`);
      const cloneToken = parsed.githubToken ?? env.DISPATCH_GITHUB_TOKEN;
      const cloneUrl = buildAuthenticatedCloneUrl(parsed.repoUrl, cloneToken);
      const cloneResult = await sandbox.exec(
        `cd ${shellQuote(workspaceDir)} && git clone ${shellQuote(cloneUrl)} .`,
      );
      if (cloneResult.exitCode !== 0) {
        return {
          ok: false,
          message: `clone_failed: ${redactToken(cloneResult.stderr, cloneToken).slice(0, 500)}`,
        };
      }

      if (parsed.branch) {
        const branchName = parsed.branch;
        const branchResult = await resolveBranch(
          sandbox,
          workspaceDir,
          branchName,
          {
            onAction: (action) => {
              preludeThoughts.push(
                action === "create"
                  ? `Creating new branch ${branchName}…`
                  : `Checking out existing branch ${branchName}…`,
              );
            },
          },
        );
        if (!branchResult.ok) {
          return {
            ok: false,
            message: `branch_setup_failed: ${branchResult.stderr.slice(0, 500)}`,
          };
        }
      }

      if (parsed.credentials) {
        try {
          await writeMcpConfig(sandbox, workspaceDir, parsed.engine, parsed.credentials);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { ok: false, message: `mcp_config_write_failed: ${msg.slice(0, 500)}` };
        }
      }

      preludeThoughts.push(
        parsed.model ? `Calling model (${parsed.model})…` : "Calling model…",
      );

      // Prefix the engine command with a `printf` that emits the setup
      // narration as prelude lines on the same stdout the engine writes
      // to. `;` (not `&&`) so a printf hiccup can't block the run.
      const processCmd = `${buildPreludeCommand(preludeThoughts)}${buildEngineCommand(parsed, workspaceDir)}`;

      await sandbox.startProcess(processCmd, {
        processId,
        // Keep the process record + logs after exit so a late
        // re-attach (caller retried after the engine already finished)
        // can still read the terminal output.
        autoCleanup: false,
        timeout: parsed.timeoutMs,
      });
      return { ok: true, processId };
    },
  });
}

type RunSandbox = ReturnType<typeof getSandbox>;

type StreamRunStart =
  | { ok: true; processId: string }
  | { ok: false; message: string };

/**
 * Tail a detached engine process and pipe its normalized events back
 * as SSE, starting from `cursor` — the number of normalized events the
 * caller already consumed on a prior attach.
 *
 * The poll loop reads the process log incrementally (by byte offset),
 * so each tick only parses freshly-appended output. It never destroys
 * the sandbox — a reader disconnect just ends this loop; the engine
 * keeps running and the next `/run/attach` resumes from a higher
 * cursor.
 *
 * The stream always closes with exactly one `result` event so the
 * caller's reader loop reaches a terminal frame; `turn_end` is
 * synthesized here for single-turn engines (pi).
 */
function streamRun(opts: {
  sandbox: RunSandbox;
  adapter: EngineAdapter;
  cursor: number;
  start: () => Promise<StreamRunStart>;
}): Response {
  const { sandbox, adapter, cursor } = opts;
  const startedAt = Date.now();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  // Set once the SSE reader disconnects (a write rejects). The detached
  // engine keeps running regardless; this just stops the tail loop so an
  // evicted caller's stale poller doesn't run alongside its retry's.
  let readerGone = false;

  async function emit(event: NormalizedEvent): Promise<void> {
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {
      // Reader disconnected — swallow and flag so the tail loop stops.
      // The engine process is detached and keeps running; the caller
      // re-attaches via /run/attach.
      readerGone = true;
    }
  }

  void (async () => {
    // `emitted` counts every normalized event in stream order,
    // including the ones skipped because they fall below `cursor`.
    let emitted = 0;
    const emitAt = async (event: NormalizedEvent): Promise<void> => {
      if (emitted >= cursor) await emit(event);
      emitted++;
    };

    try {
      const started = await opts.start();
      if (!started.ok) {
        // Setup failure (missing baseline, clone, branch, MCP). These
        // are terminal and fast — no process was started, so there is
        // nothing to re-attach to.
        await emit({ type: "error", message: started.message });
        await emit({
          type: "result",
          exit_code: 75 /* EX_TEMPFAIL */,
          duration_ms: Date.now() - startedAt,
          branch: null,
          pr_url: null,
        });
        return;
      }

      const processId = started.processId;
      let stdoutOffset = 0;
      let lineBuf = "";
      let exitCode = 1;
      let pollMs = POLL_MIN_MS;

      while (true) {
        // The reader (caller's Workflow step) disconnected — stop
        // tailing. The engine process is untouched; a retry re-attaches.
        if (readerGone) return;

        const proc = await getProcessOrNull(sandbox, processId);
        if (!proc) {
          // Process record vanished (sandbox destroyed out from under
          // us). Surface it; the caller decides whether to retry.
          await emit({ type: "error", message: "process_not_found" });
          break;
        }

        // The process can still vanish between the check above and this
        // read (idle GC, explicit destroy); a 404 here is the same
        // terminal signal as the miss above.
        const logs = await getProcessLogsOrNull(sandbox, processId);
        if (!logs) {
          await emit({ type: "error", message: "process_not_found" });
          break;
        }
        if (logs.stdout.length > stdoutOffset) {
          lineBuf += logs.stdout.slice(stdoutOffset);
          stdoutOffset = logs.stdout.length;
          const segments = lineBuf.split(/\r?\n/);
          lineBuf = segments.pop() ?? "";
          for (const line of segments) {
            for (const ev of parseLogLine(line, adapter)) await emitAt(ev);
          }
          pollMs = POLL_MIN_MS;
        } else {
          // No new output — back off so a long idle stretch doesn't
          // re-fetch the full process log every second.
          pollMs = Math.min(pollMs + 1000, POLL_MAX_MS);
        }

        if (isTerminalStatus(proc.status)) {
          exitCode = proc.exitCode ?? (proc.status === "completed" ? 0 : 1);
          break;
        }
        await sleep(pollMs);
      }

      // Flush a trailing line the engine wrote without a final newline.
      if (lineBuf.length > 0) {
        for (const ev of parseLogLine(lineBuf, adapter)) await emitAt(ev);
      }

      // Single-turn engines (pi) don't emit their own turn_end.
      if (!adapter.emitsTurnEnd) {
        await emitAt({ type: "turn_end", turn: 1, reason: "completed" });
      }
      await emitAt({
        type: "result",
        exit_code: exitCode,
        duration_ms: Date.now() - startedAt,
        // pr_url/branch stay null on the dispatcher side — the
        // linear-agent worker owns the PR flow.
        branch: null,
        pr_url: null,
      });
    } catch (e) {
      await emit({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      await emit({
        type: "result",
        exit_code: 1,
        duration_ms: Date.now() - startedAt,
        branch: null,
        pr_url: null,
      });
    } finally {
      try {
        await writer.close();
      } catch {}
      // Deliberately NO safeDestroy here. A reader disconnect must not
      // tear down the run — that is the whole point of the detached
      // process. The sandbox is destroyed explicitly via POST /run/stop
      // once the caller has consumed the terminal `result`.
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering so Cloudflare's edge doesn't accumulate
      // events before flushing to the caller.
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Build the `printf` prefix that echoes setup narration as prelude
 * events onto the engine process's stdout. Each thought becomes one
 * `__SYMPHONY_EVENT__ <json>` line; `streamRun` parses those back into
 * normalized `thought` events. Trailing `;` so the engine command runs
 * regardless of printf's exit status.
 */
function buildPreludeCommand(thoughts: string[]): string {
  if (thoughts.length === 0) return "";
  const lines = thoughts.map(
    (text) => `${PRELUDE_PREFIX}${JSON.stringify({ type: "thought", text })}`,
  );
  return `printf '%s\\n' ${lines.map(shellQuote).join(" ")} ; `;
}

/**
 * Parse one stdout line from the engine process log into normalized
 * events. Prelude lines (dispatcher-injected setup narration) are
 * decoded directly; everything else is engine output handed to the
 * adapter.
 */
export function parseLogLine(
  line: string,
  adapter: EngineAdapter,
): NormalizedEvent[] {
  if (line.length === 0) return [];
  if (line.startsWith(PRELUDE_PREFIX)) {
    try {
      return [JSON.parse(line.slice(PRELUDE_PREFIX.length)) as NormalizedEvent];
    } catch {
      return [];
    }
  }
  return adapter.parseEvents(line);
}

/** Process statuses that mean the engine is no longer producing output. */
function isTerminalStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "killed" ||
    status === "error"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deterministic background-process id for an engine turn. Per-turn so a
 * multi-turn session's turns don't collide in the same sandbox, and
 * derivable by `/run/attach` from `run_id` + `turn` alone.
 */
export function runProcessId(runId: string, turn: number): string {
  return `engine-${sanitizeScopeForId(runId)}-t${turn}`;
}

type PrepareResult =
  | { ok: true; workspaceDir: string }
  | { ok: false; status: 412 | 502; body: Record<string, unknown> };

/**
 * Restore the engine baseline, clone the repo, set up the branch, and
 * write MCP config — the setup `/run/start` runs before launching the
 * forwarder. Mirrors the buffered `/run` setup but returns a structured
 * failure for the caller to turn into a response.
 */
async function prepareWorkspace(
  env: Env,
  sandbox: RunSandbox,
  parsed: ParsedRun,
): Promise<PrepareResult> {
  const baselineEngine = resolveBaselineEngine(parsed.engine);
  const record = await new BaselineStore(env.DB).get(baselineEngine);
  if (!record) {
    return {
      ok: false,
      status: 412,
      body: {
        error: "missing_baseline",
        engine: parsed.engine,
        ...(baselineEngine !== parsed.engine
          ? { baseline_engine: baselineEngine }
          : {}),
      },
    };
  }

  await sandbox.restoreBackup(record.handle);

  const workspaceDir = `/workspace/${parsed.issueId}`;
  await sandbox.exec(`mkdir -p ${shellQuote(workspaceDir)}`);
  await sandbox.exec(
    `rm -rf ${shellQuote(workspaceDir)} && mkdir -p ${shellQuote(workspaceDir)}`,
  );

  const cloneToken = parsed.githubToken ?? env.DISPATCH_GITHUB_TOKEN;
  const cloneUrl = buildAuthenticatedCloneUrl(parsed.repoUrl, cloneToken);
  const cloneResult = await sandbox.exec(
    `cd ${shellQuote(workspaceDir)} && git clone ${shellQuote(cloneUrl)} .`,
  );
  if (cloneResult.exitCode !== 0) {
    return {
      ok: false,
      status: 502,
      body: {
        error: "clone_failed",
        exit_code: cloneResult.exitCode,
        stderr: redactToken(cloneResult.stderr, cloneToken),
      },
    };
  }

  if (parsed.branch) {
    const branchResult = await resolveBranch(
      sandbox,
      workspaceDir,
      parsed.branch,
    );
    if (!branchResult.ok) {
      return {
        ok: false,
        status: 502,
        body: {
          error: "branch_setup_failed",
          exit_code: branchResult.exitCode,
          stderr: branchResult.stderr,
        },
      };
    }
  }

  if (parsed.credentials) {
    try {
      await writeMcpConfig(
        sandbox,
        workspaceDir,
        parsed.engine,
        parsed.credentials,
      );
    } catch (e) {
      return {
        ok: false,
        status: 502,
        body: {
          error: "mcp_config_write_failed",
          exit_code: 1,
          stderr: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  return { ok: true, workspaceDir };
}

/**
 * Write the three per-run files the forwarder needs into the sandbox:
 * the forwarder script, the engine command, and the ingest config.
 */
async function writeForwarderFiles(
  sandbox: { writeFile(path: string, content: string): Promise<unknown> },
  engineCmd: string,
  ingestConfig: IngestConfig,
): Promise<void> {
  await sandbox.writeFile(FORWARDER_PATH, FORWARDER_SCRIPT);
  await sandbox.writeFile(ENGINE_CMD_PATH, engineCmd);
  await sandbox.writeFile(INGEST_CONFIG_PATH, JSON.stringify(ingestConfig));
}

/**
 * Shell command that launches the forwarder. The PATH export mirrors
 * `buildEngineEnvironment` so `node` resolves the same way the engine's
 * toolchain does; `exec` replaces the shell so the forwarder is the
 * process the dispatcher's `processId` tracks.
 */
function forwarderStartCommand(): string {
  return (
    `export HOME=${SANDBOX_HOME} && ` +
    `export PATH=${SANDBOX_HOME}/.npm-global/bin:${SANDBOX_HOME}/.local/bin:$PATH && ` +
    `exec node ${FORWARDER_PATH}`
  );
}

function adapterFor(engine: Engine): EngineAdapter {
  switch (engine) {
    case "pi":
      return piEngineAdapter;
    case "claude":
      return createClaudeEngineAdapter();
  }
}

function parseRun(body: RunBody): ParsedRun | string {
  const issueId = parseIssueId(body.issue_id);
  if (!issueId) return "invalid_issue_id";

  const repoUrl = parseRepoUrl(body.repo_url);
  if (!repoUrl) return "invalid_repo_url";

  if (typeof body.prompt !== "string" || body.prompt.length === 0) {
    return "invalid_prompt";
  }

  if (typeof body.engine !== "string" || !SUPPORTED_ENGINES.has(body.engine as Engine)) {
    return "unsupported_engine";
  }

  const model = typeof body.model === "string" && body.model.length > 0 ? body.model : null;

  const permissionMode =
    typeof body.permission_mode === "string" && body.permission_mode.length > 0
      ? body.permission_mode
      : null;
  const appendSystemPrompt =
    typeof body.append_system_prompt === "string" && body.append_system_prompt.length > 0
      ? body.append_system_prompt
      : null;
  const allowedTools = parseStringList(body.allowed_tools);
  if (allowedTools === false) return "invalid_allowed_tools";
  const disallowedTools = parseStringList(body.disallowed_tools);
  if (disallowedTools === false) return "invalid_disallowed_tools";

  const timeoutMs = parseTimeout(body.timeout_ms);

  const githubToken =
    typeof body.github_token === "string" && body.github_token.length > 0
      ? body.github_token
      : null;

  const credentials = parseCredentials(body.credentials);
  if (typeof credentials === "string") return credentials;

  const branch = parseBranch(body.branch);
  if (branch === false) return "invalid_branch";

  const turn = parseTurn(body.turn);

  // `run_id` reuses the issue-id character class (UUIDs / scoped names
  // both fit). Falls back to `issueId` so callers without a session
  // concept keep the historical per-issue sandbox behavior.
  const runId = parseIssueId(body.run_id) ?? issueId;

  const ingestUrl = parseIngestUrl(body.ingest_url);
  if (ingestUrl === false) return "invalid_ingest_url";
  // `instance_id` reuses the issue-id character class — it also has to
  // accept `:` for `<sessionId>:rN` resume instance ids.
  const instanceId = parseIssueId(body.instance_id);

  return {
    issueId,
    runId,
    repoUrl,
    prompt: body.prompt,
    engine: body.engine as Engine,
    model,
    permissionMode,
    appendSystemPrompt,
    allowedTools,
    disallowedTools,
    timeoutMs,
    githubToken,
    credentials,
    branch,
    turn,
    ingestUrl,
    instanceId,
  };
}

/**
 * Validate the optional `ingest_url` (engine-push, `/run/start`). Must
 * be an `https://` URL; we also refuse shell metacharacters as defense
 * in depth even though the value only ever lands in a JSON config file.
 *
 * Returns the trimmed value, `null` for absent, or `false` for invalid.
 */
export function parseIngestUrl(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return false;
  if (!/^https:\/\//.test(trimmed)) return false;
  if (/[\s'"`$();&|<>\\]/.test(trimmed)) return false;
  return trimmed;
}

/**
 * Validate an optional git branch name from the request body. We're
 * strict because the value flows into `git fetch` / `git checkout`
 * commands; even with shell-quoting, `--`-leading values would be
 * interpreted as flags. Rules:
 *
 *   - undefined / null → null (caller didn't ask for branch handling)
 *   - must be a non-empty string under 200 chars
 *   - must match `[a-zA-Z0-9][a-zA-Z0-9/_.-]*[a-zA-Z0-9]` (single
 *     alphanumeric is also fine)
 *   - cannot contain `..` (escapes ref namespace)
 *   - cannot end in `.lock` (git reserves these)
 *
 * Returns the trimmed value, `null` for absent, or `false` for invalid.
 */
export function parseBranch(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  if (trimmed.length === 1) {
    return /^[a-zA-Z0-9]$/.test(trimmed) ? trimmed : false;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*[a-zA-Z0-9]$/.test(trimmed)) return false;
  if (trimmed.includes("..")) return false;
  if (trimmed.endsWith(".lock")) return false;
  return trimmed;
}

function parseIssueId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // Linear identifiers are like SYM-162; allow the same character class as
  // scope so callers can also pass UUIDs or scoped names.
  if (!/^[a-zA-Z0-9._:@-]+$/.test(trimmed)) return null;
  return trimmed;
}

function parseRepoUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // Accept https or ssh-style git URLs; reject anything else so we don't
  // shell out to a file:// or arbitrary scheme.
  if (!/^(https?:\/\/|git@)/.test(trimmed)) return null;
  // Belt-and-suspenders: refuse shell metacharacters even though we
  // shell-quote on use. Defense in depth in case the quoting helper is
  // misused later.
  if (/[\s'"`$();&|<>\\]/.test(trimmed)) return null;
  return trimmed;
}

function parseStringList(value: unknown): string[] | null | false {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return false;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) return false;
    out.push(item);
  }
  return out;
}

function parseTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

/** Turn number from the request body; defaults to 1, floored, min 1. */
function parseTurn(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.floor(value);
}

/**
 * Re-attach cursor: how many normalized events the caller already
 * consumed. Defaults to 0 (replay from the start), floored, min 0.
 */
function parseCursor(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

const CREDENTIAL_ENV_MAP: Array<{
  field: keyof CredentialsBody;
  envName: string;
}> = [
  { field: "cloudflare_account_id", envName: "CLOUDFLARE_ACCOUNT_ID" },
  { field: "cloudflare_api_token", envName: "CLOUDFLARE_API_TOKEN" },
  { field: "anthropic_api_key", envName: "ANTHROPIC_API_KEY" },
  { field: "openai_api_key", envName: "OPENAI_API_KEY" },
  { field: "github_token", envName: "GITHUB_TOKEN" },
  // Linear bearer for raw GraphQL calls from the engine. We stopped
  // wiring Linear's hosted MCP into the sandbox; the engine now hits
  // https://api.linear.app/graphql directly with this token. See the
  // `Linear access (use raw GraphQL)` block appended by the
  // linear-agent worker for the contract the engine follows.
  { field: "linear_token", envName: "LINEAR_API_TOKEN" },
];

function parseCredentials(
  value: unknown,
): ParsedCredentials | null | string {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    return "invalid_credentials";
  }

  const creds = value as CredentialsBody;
  const envVars: Array<{ name: string; value: string }> = [];

  for (const { field, envName } of CREDENTIAL_ENV_MAP) {
    const v = creds[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || v.length === 0) {
      return `invalid_credentials.${field}`;
    }
    envVars.push({ name: envName, value: v });
  }

  const mcpServers: Array<{ name: string; url: string; token: string }> = [];
  if (creds.mcp_servers !== undefined && creds.mcp_servers !== null) {
    if (!Array.isArray(creds.mcp_servers)) {
      return "invalid_credentials.mcp_servers";
    }
    for (let i = 0; i < creds.mcp_servers.length; i++) {
      const srv = creds.mcp_servers[i] as McpServerBody | undefined;
      if (!srv || typeof srv !== "object" || Array.isArray(srv)) {
        return `invalid_credentials.mcp_servers[${i}]`;
      }
      if (typeof srv.name !== "string" || srv.name.length === 0) {
        return `invalid_credentials.mcp_servers[${i}].name`;
      }
      if (typeof srv.url !== "string" || srv.url.length === 0) {
        return `invalid_credentials.mcp_servers[${i}].url`;
      }
      if (typeof srv.token !== "string" || srv.token.length === 0) {
        return `invalid_credentials.mcp_servers[${i}].token`;
      }
      mcpServers.push({
        name: srv.name,
        url: srv.url,
        token: srv.token,
      });
    }
  }

  if (envVars.length === 0 && mcpServers.length === 0) return null;

  return { envVars, mcpServers };
}

/**
 * Build the shell command that invokes the engine with the user's prompt.
 *
 * Pi's CLI surface (from upstream README):
 *   - `pi --print` / `-p`: non-interactive single-turn mode
 *   - `pi --mode json`: emit events as JSON lines (lets the agent worker
 *     translate tool calls → Linear `action` activities later)
 *   - `pi --model <provider/id>`: e.g. `cloudflare-workers-ai/@cf/...`
 *   - Prompt may be argv. We shell-quote it; ARG_MAX (~2MB on Linux) is
 *     comfortably above any Linear `promptContext` we'd pass.
 *
 * This is intentionally a single string passed to `sandbox.exec` so we can
 * `cd` into the workspace dir as part of the same shell invocation. If we
 * later need finer control (per-process env, stdin), switch to writeFile +
 * exec without the `cd && ...` prefix.
 */
function buildEngineCommand(parsed: ParsedRun, workspaceDir: string): string {
  switch (parsed.engine) {
    case "pi": {
      const flags = ["--print", "--mode", "json"];
      if (parsed.model) {
        flags.push("--model", shellQuote(parsed.model));
      }
      const parts = buildEngineEnvironment(parsed);
      parts.push(
        `cd ${shellQuote(workspaceDir)}`,
        `pi ${flags.join(" ")} ${shellQuote(parsed.prompt)}`,
      );
      return parts.join(" && ");
    }
    case "claude": {
      const flags = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        shellQuote(parsed.permissionMode ?? "bypassPermissions"),
        "--dangerously-skip-permissions",
      ];
      if (parsed.credentials && parsed.credentials.mcpServers.length > 0) {
        flags.push(
          "--mcp-config",
          shellQuote(serializeMcpConfig(workspaceDir, "claude", parsed.credentials).configPath),
        );
      }
      if (parsed.model) {
        flags.push("--model", shellQuote(parsed.model));
      }
      if (parsed.appendSystemPrompt) {
        flags.push("--append-system-prompt", shellQuote(parsed.appendSystemPrompt));
      }
      if (parsed.allowedTools) {
        flags.push("--allowed-tools", ...parsed.allowedTools.map(shellQuote));
      }
      if (parsed.disallowedTools) {
        flags.push("--disallowed-tools", ...parsed.disallowedTools.map(shellQuote));
      }
      const parts = buildEngineEnvironment(parsed);
      parts.push(
        `cd ${shellQuote(workspaceDir)}`,
        `cat <<'SYMPHONY_PROMPT_EOF' | claude ${flags.join(" ")}\n${parsed.prompt}\nSYMPHONY_PROMPT_EOF`,
      );
      return parts.join(" && ");
    }
  }
}

function buildEngineEnvironment(parsed: ParsedRun): string[] {
  const parts = [
    `export HOME=${SANDBOX_HOME}`,
    `export PATH=${SANDBOX_HOME}/.npm-global/bin:${SANDBOX_HOME}/.local/bin:$PATH`,
  ];
  if (parsed.credentials) {
    for (const { name, value } of parsed.credentials.envVars) {
      parts.push(`export ${name}=${shellQuote(value)}`);
    }
  }
  return parts;
}

/**
 * Single-quote-safe shell escaping for bash. Wraps in single quotes and
 * escapes embedded single quotes via the standard `'\''` dance. Output is
 * one shell token; safe to embed directly in a command string.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Serialize MCP servers and write the config inside the cloned workspace
 * at the engine-specific location.
 *
 * Pi: writes `<workspaceDir>/.pi/mcp.json` — one of the four locations the
 * `pi-mcp-adapter` discovers (project-local override). The adapter must
 * already be installed in the baseline (`pi install npm:pi-mcp-adapter`);
 * without it the file is ignored. Schema follows the adapter's HTTP-server
 * shape: `{ url, auth: "bearer", bearerToken }`, no `type` field.
 *
 * Throws on filesystem failure — callers translate to a 502 / SSE error
 * frame. We deliberately use `sandbox.writeFile` / `sandbox.mkdir` (typed
 * SDK methods) instead of `printf '%s' > file` via `sandbox.exec` so we
 * don't have to round-trip a JSON blob through bash single-quote escaping.
 */
async function writeMcpConfig(
  sandbox: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
    writeFile(
      path: string,
      content: string,
      options?: { encoding?: string },
    ): Promise<unknown>;
  },
  workspaceDir: string,
  engine: Engine,
  credentials: ParsedCredentials,
): Promise<void> {
  if (credentials.mcpServers.length === 0) return;

  const { configDir, configPath, content } = serializeMcpConfig(
    workspaceDir,
    engine,
    credentials,
  );

  await sandbox.mkdir(configDir, { recursive: true });
  await sandbox.writeFile(configPath, content);
}

/**
 * Fetch the requested branch from origin if it exists, otherwise create
 * it locally from the current HEAD (which is the repo's default branch
 * after a fresh clone). Idempotent — calling it twice with the same
 * branch from a fresh clone yields the same state.
 *
 * Caller invariant: workspaceDir contains a clean clone of the repo on
 * its default branch. After this returns ok, HEAD is on `branch` and
 * the working tree is clean.
 *
 * Branch name has already passed `parseBranch` so it's safe to embed in
 * a shell command after `shellQuote`. We still quote defensively.
 */
async function resolveBranch(
  sandbox: {
    exec(
      cmd: string,
      opts?: { timeout?: number },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  },
  workspaceDir: string,
  branch: string,
  options?: {
    // Fires once the create-vs-checkout decision is made but BEFORE
    // the corresponding git command runs. Callers wire this into their
    // SSE stream so the UI sees "Creating new branch X" or "Checking
    // out existing branch X" in real time. Awaited so callers can
    // backpressure their writer.
    onAction?: (action: "create" | "checkout") => Promise<void> | void;
  },
): Promise<
  | { ok: true; created: boolean }
  | { ok: false; exitCode: number; stderr: string }
> {
  const wd = shellQuote(workspaceDir);
  const br = shellQuote(branch);

  // `git ls-remote --heads origin <branch>` exits 0 whether the ref is
  // found or not; the discriminator is whether stdout has any rows.
  const lsRemote = await sandbox.exec(
    `cd ${wd} && git ls-remote --heads origin ${br}`,
  );
  if (lsRemote.exitCode !== 0) {
    return { ok: false, exitCode: lsRemote.exitCode, stderr: lsRemote.stderr };
  }
  const remoteHasBranch = lsRemote.stdout.trim().length > 0;

  if (remoteHasBranch) {
    if (options?.onAction) await options.onAction("checkout");
    const fetchCheckout = await sandbox.exec(
      `cd ${wd} && git fetch origin ${br}:${br} && git checkout ${br}`,
    );
    if (fetchCheckout.exitCode !== 0) {
      return {
        ok: false,
        exitCode: fetchCheckout.exitCode,
        stderr: fetchCheckout.stderr,
      };
    }
    return { ok: true, created: false };
  }

  // Branch doesn't exist on origin — create it from the default branch
  // we just cloned onto.
  if (options?.onAction) await options.onAction("create");
  const checkout = await sandbox.exec(`cd ${wd} && git checkout -b ${br}`);
  if (checkout.exitCode !== 0) {
    return {
      ok: false,
      exitCode: checkout.exitCode,
      stderr: checkout.stderr,
    };
  }
  return { ok: true, created: true };
}

function serializeMcpConfig(
  workspaceDir: string,
  engine: Engine,
  credentials: ParsedCredentials,
): { configDir: string; configPath: string; content: string } {
  switch (engine) {
    case "pi": {
      const config = {
        mcpServers: Object.fromEntries(
          credentials.mcpServers.map((srv) => [
            srv.name,
            {
              url: srv.url,
              auth: "bearer" as const,
              bearerToken: srv.token,
            },
          ]),
        ),
      };
      const configDir = `${workspaceDir}/.pi`;
      return {
        configDir,
        configPath: `${configDir}/mcp.json`,
        content: JSON.stringify(config, null, 2),
      };
    }
    case "claude": {
      const config = {
        mcpServers: Object.fromEntries(
          credentials.mcpServers.map((srv) => [
            srv.name,
            {
              type: "http" as const,
              url: srv.url,
              headers: {
                Authorization: `Bearer ${srv.token}`,
              },
            },
          ]),
        ),
      };
      const configDir = workspaceDir;
      return {
        configDir,
        configPath: `${configDir}/.symphony-mcp-config.json`,
        content: JSON.stringify(config, null, 2),
      };
    }
  }
}

function redactRepoUrl(url: string): string {
  return url.replace(/(https?:\/\/)[^@]+@/, "$1***@");
}

/**
 * Rewrite an `https://github.com/...` URL to embed an `x-access-token:<TOKEN>@`
 * credential so `git clone` can fetch private repos non-interactively.
 * Returns the URL unchanged for ssh-style URLs (`git@github.com:...`),
 * non-https schemes, URLs that already carry credentials, or when no token
 * is available.
 *
 * Stderr from the resulting clone command can echo the URL on failure
 * (e.g. "Cloning into '.'..." followed by a fatal error), so callers
 * MUST run `redactToken` over the stderr before surfacing it.
 */
export function buildAuthenticatedCloneUrl(
  repoUrl: string,
  token: string | null | undefined,
): string {
  if (!token) return repoUrl;
  if (!repoUrl.startsWith("https://")) return repoUrl;
  if (/^https:\/\/[^/@]+@/.test(repoUrl)) return repoUrl;
  return `https://x-access-token:${token}@${repoUrl.slice("https://".length)}`;
}

/**
 * Replace every occurrence of `token` in `text` with `***`. Used to scrub
 * any leakage of the GitHub PAT from git stderr before we put it on the
 * wire (buffered JSON response or SSE error frame).
 */
export function redactToken(
  text: string,
  token: string | null | undefined,
): string {
  if (!token) return text;
  return text.split(token).join("***");
}

async function readJsonBody<T>(req: Request): Promise<T> {
  if (req.method === "GET" || req.method === "HEAD") return {} as T;
  const text = await req.clone().text();
  if (text.trim() === "") return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

