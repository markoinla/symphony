import { Hono } from "hono";
import { getSandbox, parseSSEStream } from "@cloudflare/sandbox";

import type { Env } from "./index";
import { BaselineStore } from "./storage";
import { SANDBOX_HOME, safeDestroy, sanitizeScopeForId } from "./sandbox-helpers";
import { piEngineAdapter } from "./engines/pi";
import type { EngineAdapter, NormalizedEvent } from "./engines/types";
import { commitAndPush } from "./git";

/**
 * `/run` — execute one agent turn in a fresh per-issue sandbox.
 *
 * Flow:
 *   1. Look up the baseline snapshot for `engine`. 412 if absent.
 *   2. Get a per-issue sandbox (`run-<sanitized-issue-id>`), restore the
 *      baseline so engine binary + base toolchain are available.
 *   3. Clone `repo_url` into `/workspace/<issue_id>`.
 *   4. Inject per-tenant credentials (env vars, MCP config) from the
 *      `credentials` block.
 *   5. Build an engine command and exec it with the configured timeout.
 *   6. Always destroy the sandbox in `finally`.
 *
 * Returns `{ engine, exit_code, stdout, stderr, duration_ms }` on success.
 *
 * Baselines contain only binaries (no credentials). Per-tenant secrets
 * arrive via the `credentials` block on each `/run` request.
 */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

const SUPPORTED_ENGINES = new Set(["pi"] as const);
type Engine = "pi";

interface RunBody {
  issue_id?: unknown;
  repo_url?: unknown;
  prompt?: unknown;
  engine?: unknown;
  model?: unknown;
  timeout_ms?: unknown;
  max_turns?: unknown;
  github_token?: unknown;
  credentials?: unknown;
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
  repoUrl: string;
  prompt: string;
  engine: Engine;
  model: string | null;
  timeoutMs: number;
  githubToken: string | null;
  credentials: ParsedCredentials | null;
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
    const record = await store.get(parsed.engine);
    if (!record) {
      return c.json({ error: "missing_baseline", engine: parsed.engine }, 412);
    }

    const sandbox = getSandbox(c.env.Sandbox, runSandboxId(parsed.issueId));
    const startedAt = Date.now();

    try {
      await sandbox.restoreBackup(record.handle);

      const workspaceDir = `/workspace/${parsed.issueId}`;
      await sandbox.exec(`mkdir -p ${shellQuote(workspaceDir)}`);

      // Best-effort clean clone: if the dir already had something, blow it
      // away so `git clone` doesn't fail. Per-issue sandbox ID means this is
      // only nonempty if a previous /run for the same issue raced or failed
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

      let branch: string | null = null;
      let commitSha: string | null = null;
      let pushError: string | null = null;
      const pushToken = parsed.githubToken ?? c.env.DISPATCH_GITHUB_TOKEN;
      if (result.exitCode === 0 && pushToken) {
        try {
          const pushed = await commitAndPush(sandbox, workspaceDir, {
            issueIdentifier: parsed.issueId,
            githubToken: pushToken,
          });
          branch = pushed?.branch ?? null;
          commitSha = pushed?.commit_sha ?? null;
        } catch (e) {
          pushError = e instanceof Error ? e.message : String(e);
        }
      }

      return c.json({
        engine: parsed.engine,
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: Date.now() - startedAt,
        branch,
        commit_sha: commitSha,
        push_error: pushError,
      });
    } finally {
      await safeDestroy(sandbox);
    }
  });

  app.post("/run/stop", async (c) => {
    const body = await readJsonBody<{ issue_id?: unknown }>(c.req.raw);
    const issueId = parseIssueId(body.issue_id);
    if (!issueId) {
      return c.json({ error: "invalid_issue_id" }, 400);
    }
    const sandbox = getSandbox(c.env.Sandbox, runSandboxId(issueId));
    await safeDestroy(sandbox);
    return c.json({ ok: true, issue_id: issueId });
  });

  return app;
}

export function runSandboxId(issueId: string): string {
  return `run-${sanitizeScopeForId(issueId)}`;
}

/**
 * Streaming branch of `/run`. Same setup as the buffered branch (snap
 * restore, clone, build engine command) but executes the engine via
 * `sandbox.execStream` and pipes normalized engine events back as SSE.
 *
 * Wire format mirrors the engine-agnostic envelope in
 * `src/engines/types.ts`. Each `data:` line is a JSON-encoded
 * NormalizedEvent. The stream always terminates with exactly one
 * `result` event (exit_code + duration_ms) followed by stream close,
 * even on internal error — so the caller's reader loop always reaches
 * a terminal frame.
 *
 * Backpressure / cancellation: if the caller disconnects, the writer's
 * close() rejects, we catch it, and the `finally` block destroys the
 * sandbox so a stale pi process doesn't keep burning CPU. (The pi
 * subprocess inside the container exits when stdin closes; the
 * container itself is destroyed by `safeDestroy`.)
 */
async function runStreaming(env: Env, parsed: ParsedRun): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, runSandboxId(parsed.issueId));
  const adapter = adapterFor(parsed.engine);
  const startedAt = Date.now();

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  async function emit(event: NormalizedEvent): Promise<void> {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    try {
      await writer.write(encoder.encode(frame));
    } catch {
      // Reader has disconnected; swallow so the cleanup path runs.
    }
  }

  async function emitTerminal(
    exitCode: number,
    options: {
      message?: string;
      branch?: string | null;
    } = {},
  ): Promise<void> {
    if (options.message) {
      await emit({ type: "error", message: options.message });
    }
    await emit({
      type: "result",
      exit_code: exitCode,
      duration_ms: Date.now() - startedAt,
      branch: options.branch ?? null,
      // pr_url stays null on the dispatcher side — the linear-agent
      // worker creates the PR after seeing this `result` event and
      // attaches the URL to Linear directly.
      pr_url: null,
    });
  }

  // Run the dispatch in the background; the response Response object
  // returns the readable end of the pipe immediately so SSE headers
  // flush before the engine even starts.
  //
  // Every code path inside the IIFE must reach `emitTerminal` so the
  // SSE stream closes with a `result` frame. The first await (baseline
  // lookup) is inside the try/catch on purpose: a failure here used to
  // orphan the writable side of the TransformStream and let the
  // Workers runtime kill the request after a hang-detection timeout,
  // surfacing on the caller as `stream_closed_without_result_frame`.
  void (async () => {
    try {
      const record = await new BaselineStore(env.DB).get(parsed.engine);
      if (!record) {
        await emitTerminal(75 /* EX_TEMPFAIL */, {
          message: `missing_baseline: ${parsed.engine}`,
        });
        return;
      }

      await emit({
        type: "thought",
        text: `Restoring ${parsed.engine} baseline snapshot…`,
      });
      await sandbox.restoreBackup(record.handle);

      const workspaceDir = `/workspace/${parsed.issueId}`;
      await sandbox.exec(`mkdir -p ${shellQuote(workspaceDir)}`);
      await sandbox.exec(
        `rm -rf ${shellQuote(workspaceDir)} && mkdir -p ${shellQuote(workspaceDir)}`,
      );
      await emit({
        type: "thought",
        text: `Cloning ${redactRepoUrl(parsed.repoUrl)}…`,
      });
      const streamCloneToken = parsed.githubToken ?? env.DISPATCH_GITHUB_TOKEN;
      const streamCloneUrl = buildAuthenticatedCloneUrl(
        parsed.repoUrl,
        streamCloneToken,
      );
      const cloneResult = await sandbox.exec(
        `cd ${shellQuote(workspaceDir)} && git clone ${shellQuote(streamCloneUrl)} .`,
      );
      if (cloneResult.exitCode !== 0) {
        await emitTerminal(cloneResult.exitCode, {
          message: `clone_failed: ${redactToken(cloneResult.stderr, streamCloneToken).slice(0, 500)}`,
        });
        return;
      }

      if (parsed.credentials) {
        try {
          await writeMcpConfig(sandbox, workspaceDir, parsed.engine, parsed.credentials);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await emitTerminal(1, {
            message: `mcp_config_write_failed: ${msg.slice(0, 500)}`,
          });
          return;
        }
      }

      const cmd = buildEngineCommand(parsed, workspaceDir);
      await emit({
        type: "thought",
        text: parsed.model
          ? `Calling model (${parsed.model})…`
          : "Calling model…",
      });
      const execStream = await sandbox.execStream(cmd, {
        timeout: parsed.timeoutMs,
      });

      // execStream returns an SSE stream of ExecEvent records. We
      // line-buffer the `stdout` payloads so partial lines spanning two
      // ExecEvent chunks parse correctly.
      let stdoutBuffer = "";
      let exitCode = 0;

      for await (const ev of parseSSEStream<ExecEvent>(execStream)) {
        if (ev.type === "stdout" && typeof ev.data === "string") {
          stdoutBuffer += ev.data;
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) {
            for (const normalized of adapter.parseEvents(line)) {
              await emit(normalized);
            }
          }
        } else if (ev.type === "complete") {
          exitCode = ev.exitCode ?? 0;
        } else if (ev.type === "error") {
          await emit({
            type: "error",
            message: ev.error ?? "engine_error",
          });
        }
      }

      // Flush any trailing buffered line that didn't end in a newline.
      if (stdoutBuffer.length > 0) {
        for (const normalized of adapter.parseEvents(stdoutBuffer)) {
          await emit(normalized);
        }
      }

      // Single-turn engines (pi today) get a synthetic `turn_end` so
      // the client can attribute the prior activities to a turn.
      // Multi-turn engines (future codex/claude) will emit this
      // themselves and we'll skip this block.
      await emit({ type: "turn_end", turn: 1, reason: "completed" });

      // Item 4: commit and push to GitHub if the engine succeeded and
      // a token is configured. Push failures don't fail the whole
      // run — we surface them as an `error` event so users see them
      // in the timeline, then continue to the result frame.
      // SYM-269: prefer the per-run token from the body over the env.
      let branch: string | null = null;
      const streamPushToken = parsed.githubToken ?? env.DISPATCH_GITHUB_TOKEN;
      if (exitCode === 0 && streamPushToken) {
        try {
          const pushed = await commitAndPush(sandbox, workspaceDir, {
            issueIdentifier: parsed.issueId,
            githubToken: streamPushToken,
          });
          branch = pushed?.branch ?? null;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await emit({ type: "error", message: `push_failed: ${msg}` });
        }
      }

      await emitTerminal(exitCode, { branch });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await emitTerminal(1, { message });
    } finally {
      try {
        await writer.close();
      } catch {}
      await safeDestroy(sandbox);
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

interface ExecEvent {
  type: "start" | "stdout" | "stderr" | "complete" | "error";
  timestamp?: string;
  data?: string;
  command?: string;
  exitCode?: number;
  error?: string;
  sessionId?: string;
  pid?: number;
}

function adapterFor(engine: Engine): EngineAdapter {
  switch (engine) {
    case "pi":
      return piEngineAdapter;
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

  const timeoutMs = parseTimeout(body.timeout_ms);

  const githubToken =
    typeof body.github_token === "string" && body.github_token.length > 0
      ? body.github_token
      : null;

  const credentials = parseCredentials(body.credentials);
  if (typeof credentials === "string") return credentials;

  return {
    issueId,
    repoUrl,
    prompt: body.prompt,
    engine: body.engine as Engine,
    model,
    timeoutMs,
    githubToken,
    credentials,
  };
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

function parseTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
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
      const parts = [
        `export HOME=${SANDBOX_HOME}`,
        `export PATH=${SANDBOX_HOME}/.npm-global/bin:${SANDBOX_HOME}/.local/bin:$PATH`,
      ];
      if (parsed.credentials) {
        for (const { name, value } of parsed.credentials.envVars) {
          parts.push(`export ${name}=${shellQuote(value)}`);
        }
      }
      parts.push(
        `cd ${shellQuote(workspaceDir)}`,
        `pi ${flags.join(" ")} ${shellQuote(parsed.prompt)}`,
      );
      return parts.join(" && ");
    }
  }
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

