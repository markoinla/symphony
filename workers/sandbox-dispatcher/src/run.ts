import { Hono } from "hono";
import { getSandbox, parseSSEStream } from "@cloudflare/sandbox";

import type { Env } from "./index";
import { AuthBackupStore } from "./storage";
import { SANDBOX_HOME, safeDestroy, sanitizeScopeForId } from "./sandbox-helpers";
import { piEngineAdapter } from "./engines/pi";
import type { EngineAdapter, NormalizedEvent } from "./engines/types";
import { commitAndPush } from "./git";

/**
 * `/run` — execute one agent turn in a fresh per-issue sandbox.
 *
 * Flow:
 *   1. Look up the snapshot handle for `scope`. 412 if absent.
 *   2. Get a per-issue sandbox (`run-<sanitized-issue-id>`), restore the
 *      snapshot so all CLI auth + binaries are available.
 *   3. Clone `repo_url` into `/workspace/<issue_id>`.
 *   4. Build an engine command for `engine` ("pi" today; "codex"/"claude"
 *      reserved for future engines) and exec it with the configured timeout.
 *   5. Always destroy the sandbox in `finally` — leases are short-lived
 *      and we don't want containers leaking on the operator's account.
 *
 * Returns `{ engine, exit_code, stdout, stderr, duration_ms }` on success.
 *
 * Authentication state:
 *   - Pre-SYM-268: baked into the per-tenant snapshot via interactive PTY
 *     bootstrap. Single-tenant only.
 *   - SYM-268: each /run carries a `credentials` block — env vars
 *     (Anthropic/OpenAI/CF Workers AI keys, short-lived GH App
 *     installation token) and optional MCP server bearers. The
 *     dispatcher stays credential-agnostic; linear-agent decrypts +
 *     signs the body.
 */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

const SUPPORTED_ENGINES = new Set(["pi"] as const);
type Engine = "pi";

// MCP config lives next to pi's auth — under HOME so a `pi` invocation
// with the right HOME finds it without needing an env override.
const MCP_CONFIG_PATH = `${SANDBOX_HOME}/.config/pi/mcp.json`;

/**
 * Allow-list of credential field names. The shape stays optional in
 * the wire so callers can omit irrelevant ones (a CF Workers AI run
 * doesn't need ANTHROPIC_API_KEY). The dispatcher injects only what's
 * present.
 */
const ENV_FIELD_TO_ENV_NAME: Record<string, string> = {
  cloudflare_account_id: "CLOUDFLARE_ACCOUNT_ID",
  cloudflare_api_token: "CLOUDFLARE_API_TOKEN",
  anthropic_api_key: "ANTHROPIC_API_KEY",
  openai_api_key: "OPENAI_API_KEY",
  // `github_token` is NOT exported as an env var — git's HTTPS auth
  // uses the URL-embedded `x-access-token:<tok>` pattern (rewritten by
  // linear-agent before /run), and `commitAndPush` consumes it
  // directly. Exporting it as GITHUB_TOKEN would also leak it to the
  // engine subprocess.
};

interface RunCredentialsInput {
  cloudflare_account_id?: unknown;
  cloudflare_api_token?: unknown;
  anthropic_api_key?: unknown;
  openai_api_key?: unknown;
  github_token?: unknown;
  mcp_servers?: unknown;
}

interface McpServerEntry {
  name: string;
  url: string;
  token: string;
}

interface ParsedCredentials {
  envVars: Record<string, string>;
  githubToken: string | null;
  mcpServers: McpServerEntry[];
}

interface RunBody {
  scope?: unknown;
  issue_id?: unknown;
  repo_url?: unknown;
  prompt?: unknown;
  engine?: unknown;
  model?: unknown;
  timeout_ms?: unknown;
  max_turns?: unknown;
  credentials?: unknown;
}

interface ParsedRun {
  scope: string;
  issueId: string;
  repoUrl: string;
  prompt: string;
  engine: Engine;
  model: string | null;
  timeoutMs: number;
  credentials: ParsedCredentials;
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
    // happen.
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/event-stream")) {
      return runStreaming(c.env, parsed);
    }

    // SYM-268: prefer baseline-per-engine snapshot; fall back to the
    // legacy per-tenant `scope` snapshot during cutover so single-org
    // deploys keep working until ops runs scripts/build-baseline.sh.
    const store = new AuthBackupStore(c.env.DB);
    const record =
      (await store.get(`baseline-${parsed.engine}`)) ??
      (await store.get(parsed.scope));
    if (!record) {
      return c.json(
        { error: "missing_auth_backup", scope: parsed.scope, engine: parsed.engine },
        412,
      );
    }

    const sandbox = getSandbox(c.env.Sandbox, runSandboxId(parsed.issueId));
    const startedAt = Date.now();

    try {
      await sandbox.restoreBackup(record.handle);

      const workspaceDir = `/workspace/${parsed.issueId}`;
      await sandbox.exec(`mkdir -p ${shellQuote(workspaceDir)}`);

      // Best-effort clean clone: if the dir already had something, blow it
      // away so `git clone` doesn't fail.
      await sandbox.exec(
        `rm -rf ${shellQuote(workspaceDir)} && mkdir -p ${shellQuote(workspaceDir)}`,
      );

      const cloneResult = await sandbox.exec(
        `cd ${shellQuote(workspaceDir)} && git clone ${shellQuote(parsed.repoUrl)} .`,
      );
      if (cloneResult.exitCode !== 0) {
        return c.json(
          {
            error: "clone_failed",
            exit_code: cloneResult.exitCode,
            stderr: cloneResult.stderr,
          },
          502,
        );
      }

      if (parsed.credentials.mcpServers.length > 0) {
        await writeMcpConfig(sandbox, parsed.credentials.mcpServers);
      }

      const cmd = buildEngineCommand(parsed, workspaceDir);
      const result = await sandbox.exec(cmd, { timeout: parsed.timeoutMs });

      // Push via GitHub App-minted installation token (SYM-268). Falls
      // back to the legacy `DISPATCH_GITHUB_TOKEN` env secret only
      // when the body didn't carry one, so single-tenant deploys keep
      // working until orgs install the App.
      const pushToken =
        parsed.credentials.githubToken ?? c.env.DISPATCH_GITHUB_TOKEN ?? null;
      let branch: string | null = null;
      let commitSha: string | null = null;
      let pushError: string | null = null;
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
 * Logging discipline: every console.log in this branch may flow into
 * Cloudflare's logs and (via `wrangler tail`) onto operator screens.
 * We log env-var *names* set, never values. The injected `export`
 * lines themselves only land in the sandbox's exec command string,
 * which is NOT echoed by sandbox.exec/execStream beyond what the
 * engine itself prints.
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
      // Reader disconnected; swallow so cleanup runs.
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
      pr_url: null,
    });
  }

  void (async () => {
    const store = new AuthBackupStore(env.DB);
    const record =
      (await store.get(`baseline-${parsed.engine}`)) ??
      (await store.get(parsed.scope));
    try {
      if (!record) {
        await emitTerminal(75 /* EX_TEMPFAIL */, {
          message: `missing_auth_backup: scope=${parsed.scope} engine=${parsed.engine}`,
        });
        return;
      }

      await emit({
        type: "thought",
        text: "Restoring sandbox environment from snapshot…",
      });
      await sandbox.restoreBackup(record.handle);

      const workspaceDir = `/workspace/${parsed.issueId}`;
      await sandbox.exec(`mkdir -p ${shellQuote(workspaceDir)}`);
      await sandbox.exec(
        `rm -rf ${shellQuote(workspaceDir)} && mkdir -p ${shellQuote(workspaceDir)}`,
      );
      await emit({
        type: "thought",
        text: `Cloning ${parsed.repoUrl}…`,
      });
      const cloneResult = await sandbox.exec(
        `cd ${shellQuote(workspaceDir)} && git clone ${shellQuote(parsed.repoUrl)} .`,
      );
      if (cloneResult.exitCode !== 0) {
        await emitTerminal(cloneResult.exitCode, {
          message: `clone_failed: ${cloneResult.stderr.slice(0, 500)}`,
        });
        return;
      }

      if (parsed.credentials.mcpServers.length > 0) {
        await writeMcpConfig(sandbox, parsed.credentials.mcpServers);
      }

      // Log only var-name surface, never values. The injected exports
      // never appear in stdout/stderr; this line documents what we
      // shipped per /run for observability.
      const envNamesSet = Object.keys(parsed.credentials.envVars);
      if (envNamesSet.length > 0 || parsed.credentials.mcpServers.length > 0) {
        console.log(
          "run.credentials_injected",
          JSON.stringify({
            issue_id: parsed.issueId,
            scope: parsed.scope,
            env_vars: envNamesSet,
            mcp_servers: parsed.credentials.mcpServers.map((s) => s.name),
            github_token_present: parsed.credentials.githubToken !== null,
          }),
        );
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

      if (stdoutBuffer.length > 0) {
        for (const normalized of adapter.parseEvents(stdoutBuffer)) {
          await emit(normalized);
        }
      }

      await emit({ type: "turn_end", turn: 1, reason: "completed" });

      const pushToken =
        parsed.credentials.githubToken ?? env.DISPATCH_GITHUB_TOKEN ?? null;
      let branch: string | null = null;
      if (exitCode === 0 && pushToken) {
        try {
          const pushed = await commitAndPush(sandbox, workspaceDir, {
            issueIdentifier: parsed.issueId,
            githubToken: pushToken,
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

interface SandboxWriteFile {
  writeFile?(path: string, content: string): Promise<unknown>;
}

/**
 * Write `~/.config/pi/mcp.json` for pi's MCP client. The format
 * matches what pi expects (see upstream docs): a top-level
 * `mcpServers` map keyed by server name with `url` + `Authorization`
 * header. We restrict to bearer-token auth — that's what Linear MCP
 * uses today; future providers (GitHub MCP, Notion MCP) follow the
 * same pattern.
 *
 * `sandbox.writeFile` may not be present on older SDK versions; fall
 * back to a heredoc-style `cat > file <<EOF` if needed. Heredoc body
 * carries credentials, so we can't log the command.
 */
async function writeMcpConfig(
  sandbox: SandboxWriteFile & { exec: (cmd: string) => Promise<unknown> },
  mcpServers: McpServerEntry[],
): Promise<void> {
  const config = {
    mcpServers: Object.fromEntries(
      mcpServers.map((s) => [
        s.name,
        {
          url: s.url,
          headers: { Authorization: `Bearer ${s.token}` },
        },
      ]),
    ),
  };
  const json = JSON.stringify(config);

  if (typeof sandbox.writeFile === "function") {
    // Ensure parent directory exists.
    await sandbox.exec(
      `mkdir -p ${shellQuote(`${SANDBOX_HOME}/.config/pi`)}`,
    );
    await sandbox.writeFile(MCP_CONFIG_PATH, json);
    return;
  }
  // Heredoc fallback. Using `bash -c` with a here-doc keeps the JSON
  // off stdout (no echo). The heredoc body never lands in a stderr/
  // stdout buffer because we redirect both to /dev/null.
  const b64 = btoa(json);
  await sandbox.exec(
    `mkdir -p ${shellQuote(`${SANDBOX_HOME}/.config/pi`)} && ` +
      `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(MCP_CONFIG_PATH)} 2>/dev/null`,
  );
}

function adapterFor(engine: Engine): EngineAdapter {
  switch (engine) {
    case "pi":
      return piEngineAdapter;
  }
}

function parseRun(body: RunBody): ParsedRun | string {
  const scope = parseScope(body.scope);
  if (!scope) return "invalid_scope";

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

  const credentials = parseCredentials(body.credentials);
  if (typeof credentials === "string") return credentials;

  return {
    scope,
    issueId,
    repoUrl,
    prompt: body.prompt,
    engine: body.engine as Engine,
    model,
    timeoutMs,
    credentials,
  };
}

function parseCredentials(raw: unknown): ParsedCredentials | string {
  const empty: ParsedCredentials = {
    envVars: {},
    githubToken: null,
    mcpServers: [],
  };
  if (raw === undefined || raw === null) return empty;
  if (typeof raw !== "object") return "invalid_credentials";
  const obj = raw as RunCredentialsInput;

  const envVars: Record<string, string> = {};
  for (const [field, envName] of Object.entries(ENV_FIELD_TO_ENV_NAME)) {
    const v = (obj as Record<string, unknown>)[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || v.length === 0) {
      return `invalid_credentials_${field}`;
    }
    envVars[envName] = v;
  }

  let githubToken: string | null = null;
  if (obj.github_token !== undefined && obj.github_token !== null) {
    if (typeof obj.github_token !== "string" || obj.github_token.length === 0) {
      return "invalid_credentials_github_token";
    }
    githubToken = obj.github_token;
  }

  const mcpServers: McpServerEntry[] = [];
  if (obj.mcp_servers !== undefined && obj.mcp_servers !== null) {
    if (!Array.isArray(obj.mcp_servers)) return "invalid_credentials_mcp_servers";
    for (const entry of obj.mcp_servers) {
      if (typeof entry !== "object" || entry === null) {
        return "invalid_credentials_mcp_servers";
      }
      const e = entry as Partial<McpServerEntry>;
      if (
        typeof e.name !== "string" || e.name.length === 0 ||
        typeof e.url !== "string" || !/^https?:\/\//.test(e.url) ||
        typeof e.token !== "string" || e.token.length === 0
      ) {
        return "invalid_credentials_mcp_servers";
      }
      mcpServers.push({ name: e.name, url: e.url, token: e.token });
    }
  }

  return { envVars, githubToken, mcpServers };
}

function parseScope(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^[a-zA-Z0-9._:@-]+$/.test(trimmed)) return null;
  return trimmed;
}

function parseIssueId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^[a-zA-Z0-9._:@-]+$/.test(trimmed)) return null;
  return trimmed;
}

function parseRepoUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // Accept https or ssh-style git URLs. Allow `@` so the linear-agent
  // can pass `https://x-access-token:<TOKEN>@github.com/owner/repo.git`
  // with a GH App-minted installation token — we still refuse the
  // shell-dangerous metacharacters below.
  if (!/^(https?:\/\/|git@)/.test(trimmed)) return null;
  if (/[\s'"`$();&|<>\\]/.test(trimmed)) return null;
  return trimmed;
}

function parseTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

/**
 * Build the shell command that invokes the engine with the user's prompt.
 *
 * SYM-268: any `credentials.envVars` are prepended as `export NAME=<value>`
 * lines. `shellQuote` handles every value, including ones containing
 * single quotes (the standard `'\''` dance), so a tenant's key with a
 * `'` doesn't break the shell command.
 *
 * Pi's CLI surface (from upstream README):
 *   - `pi --print` / `-p`: non-interactive single-turn mode
 *   - `pi --mode json`: emit events as JSON lines
 *   - `pi --model <provider/id>`: e.g. `cloudflare-workers-ai/@cf/...`
 *   - Prompt may be argv. We shell-quote it; ARG_MAX (~2MB on Linux) is
 *     comfortably above any Linear `promptContext` we'd pass.
 */
function buildEngineCommand(parsed: ParsedRun, workspaceDir: string): string {
  switch (parsed.engine) {
    case "pi": {
      const flags = ["--print", "--mode", "json"];
      if (parsed.model) {
        flags.push("--model", shellQuote(parsed.model));
      }
      const lines: string[] = [];
      // sandbox.exec runs a non-login shell. Reproduce the .bashrc
      // essentials so pi (and the co-installed gh / claude / codex
      // CLIs in the snapshot) resolve.
      lines.push(`export HOME=${SANDBOX_HOME}`);
      lines.push(
        `export PATH=${SANDBOX_HOME}/.npm-global/bin:${SANDBOX_HOME}/.local/bin:$PATH`,
      );
      // Per-tenant env injections (SYM-268). Order is irrelevant —
      // we sort to keep the command string stable across runs for
      // easier diffing in `wrangler tail` (the *names* show; values
      // don't).
      for (const name of Object.keys(parsed.credentials.envVars).sort()) {
        lines.push(`export ${name}=${shellQuote(parsed.credentials.envVars[name]!)}`);
      }
      lines.push(`cd ${shellQuote(workspaceDir)}`);
      lines.push(`pi ${flags.join(" ")} ${shellQuote(parsed.prompt)}`);
      return lines.join(" && ");
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
