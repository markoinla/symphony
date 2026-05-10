import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";

import type { Env } from "./index";
import { AuthBackupStore } from "./storage";

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
 * Authentication state (Anthropic/OpenAI/Cloudflare API keys, model
 * config) lives entirely in the snapshot — the dispatcher never sees
 * provider credentials. Operators authenticate `pi` interactively during
 * `/auth/bootstrap` and snapshot the result.
 */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

const SUPPORTED_ENGINES = new Set(["pi"] as const);
type Engine = "pi";

interface RunBody {
  scope?: unknown;
  issue_id?: unknown;
  repo_url?: unknown;
  prompt?: unknown;
  engine?: unknown;
  model?: unknown;
  timeout_ms?: unknown;
  max_turns?: unknown;
}

interface ParsedRun {
  scope: string;
  issueId: string;
  repoUrl: string;
  prompt: string;
  engine: Engine;
  model: string | null;
  timeoutMs: number;
}

export function buildRunRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/run", async (c) => {
    const body = await readJsonBody<RunBody>(c.req.raw);
    const parsed = parseRun(body);
    if (typeof parsed === "string") {
      return c.json({ error: parsed }, 400);
    }

    const store = new AuthBackupStore(c.env.DB);
    const record = await store.get(parsed.scope);
    if (!record) {
      // Phase 4 plan: 412 (Precondition Failed), not 404. The caller is
      // expected to bootstrap+snapshot before running; the snapshot is the
      // precondition.
      return c.json({ error: "missing_auth_backup", scope: parsed.scope }, 412);
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

      const cmd = buildEngineCommand(parsed, workspaceDir);
      const result = await sandbox.exec(cmd, { timeout: parsed.timeoutMs });

      return c.json({
        engine: parsed.engine,
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: Date.now() - startedAt,
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
  // Same sanitization rule as bootstrapSandboxId — DNS-safe label so preview
  // URLs (https://<port>-<sandbox-id>-<token>.<host>) don't silently fail.
  const safe = issueId.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  return `run-${safe}`;
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

  return {
    scope,
    issueId,
    repoUrl,
    prompt: body.prompt,
    engine: body.engine as Engine,
    model,
    timeoutMs,
  };
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
      return [
        `cd ${shellQuote(workspaceDir)}`,
        `pi ${flags.join(" ")} ${shellQuote(parsed.prompt)}`,
      ].join(" && ");
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

async function safeDestroy(sandbox: { destroy(): Promise<void> }): Promise<void> {
  try {
    await sandbox.destroy();
  } catch {
    // Mirror auth.ts: cleanup failure shouldn't mask the real result.
  }
}
