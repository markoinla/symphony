import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";

import type { Env } from "./index";
import { BaselineStore } from "./storage";
import {
  SANDBOX_HOME,
  SNAPSHOT_DIR,
  SNAPSHOT_TTL_SECONDS,
  safeDestroy,
  useLocalBackupBucket,
} from "./sandbox-helpers";

/**
 * Interactive baseline edit + save routes.
 *
 * Manual flow:
 *   1. Operator POSTs `/baselines/edit { engine }`. The dispatcher boots a
 *      sandbox tagged `baseline-edit-<engine>`, restores the current
 *      engine baseline if one exists, ensures ttyd is installed, starts
 *      ttyd on port 7681, and returns a one-time PTY URL.
 *   2. Operator opens the PTY URL in a browser, edits the baseline
 *      interactively (CLI logins, tool installs, env tweaks, etc.).
 *   3. Operator POSTs `/baselines/save { engine, version? }`. The
 *      dispatcher calls `sandbox.createBackup({ dir: SNAPSHOT_DIR, ... })`,
 *      atomically replaces the D1 row, and destroys the sandbox.
 *
 * Only the three supported engines are accepted (pi, codex, claude) so
 * the sandbox ID and D1 key are tightly bounded.
 */

const SUPPORTED_ENGINES = ["pi", "codex", "claude"] as const;
type BaselineEngine = (typeof SUPPORTED_ENGINES)[number];

// PTY sessions auto-expire on the SDK side after this many ms; the caller
// is expected to either snapshot before then or hit `/baselines/save`
// (which destroys the sandbox) explicitly.
const EDIT_TTL_MS = 30 * 60 * 1000;

const TTYD_PORT = 7681;
const TTYD_PATH = `${SANDBOX_HOME}/.local/bin/ttyd`;
const TTYD_VERSION = "1.7.7";

// Idempotent prep: downloads ttyd if absent, writes .bashrc/.bash_profile
// if absent. Anything already present from a prior baseline restore is
// preserved (operator customizations survive across edits).
const EDIT_PREP_CMD =
  `mkdir -p ${SANDBOX_HOME}/.local/bin ${SANDBOX_HOME}/.npm-global && ` +
  `(test -x ${TTYD_PATH} || ` +
  `(curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" ` +
  `-o ${TTYD_PATH} && chmod +x ${TTYD_PATH})) && ` +
  `(test -f ${SANDBOX_HOME}/.bashrc || cat > ${SANDBOX_HOME}/.bashrc <<'BASHRC'\n` +
  `export HOME=${SANDBOX_HOME}\n` +
  `export PATH=${SANDBOX_HOME}/.local/bin:${SANDBOX_HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin\n` +
  `export NPM_CONFIG_PREFIX=${SANDBOX_HOME}/.npm-global\n` +
  `cd ${SANDBOX_HOME}\n` +
  `BASHRC\n` +
  `) && ` +
  `(test -f ${SANDBOX_HOME}/.bash_profile || cat > ${SANDBOX_HOME}/.bash_profile <<'PROF'\n` +
  `[ -f ~/.bashrc ] && . ~/.bashrc\n` +
  `PROF\n` +
  `)`;

interface EditBody {
  engine?: unknown;
}

interface SaveBody {
  engine?: unknown;
  version?: unknown;
}

export function buildBaselineEditRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/baselines/edit", async (c) => {
    const body = await readJsonBody<EditBody>(c.req.raw);
    const engine = parseEngine(body.engine);
    if (!engine) {
      return c.json(
        { error: "invalid_engine", supported: [...SUPPORTED_ENGINES] },
        400,
      );
    }

    const sandboxId = editSandboxId(engine);

    // Tear down any prior edit sandbox for this engine so port state and
    // stale ttyd processes don't leak in. The DO is recreated on the next
    // getSandbox() call.
    await safeDestroy(getSandbox(c.env.Sandbox, sandboxId));
    const sandbox = getSandbox(c.env.Sandbox, sandboxId);

    // Restore the current baseline so edits start from the latest state.
    const store = new BaselineStore(c.env.DB);
    const prior = await store.get(engine);
    if (prior) {
      await sandbox.restoreBackup(prior.handle);
    }

    // Ensure ttyd + bashrc are in place under SANDBOX_HOME. No-op if a
    // prior baseline already restored them.
    await sandbox.exec(EDIT_PREP_CMD);

    // Start ttyd with HOME pointed at SANDBOX_HOME so every CLI's auth
    // files (~/.claude, ~/.codex, ~/.config/gh) and `npm install -g`
    // globals land inside the snapshot. `-W` enables write access;
    // `-t titleFixed` keeps the browser tab title deterministic.
    const ttydProc = await sandbox.startProcess(
      `env HOME=${SANDBOX_HOME} ${TTYD_PATH} -p ${TTYD_PORT} -W ` +
        `-t titleFixed=symphony-baseline-${engine} bash -l`,
      { autoCleanup: false },
    );

    // SDK best practice: wait for the port to be reachable from the SDK's
    // probe vantage point BEFORE exposing it. Without this the browser
    // hits proxyToSandbox first, the SDK then runs its 90s probe, and the
    // user sees a delayed 503 instead of a clear bootstrap error.
    await ttydProc.waitForPort(TTYD_PORT, {
      mode: "http",
      path: "/",
      status: { min: 200, max: 399 },
      timeout: 30_000,
    });

    const hostname = new URL(c.req.url).host;
    const exposed = await sandbox.exposePort(TTYD_PORT, { hostname });

    return c.json({
      pty_url: exposed.url,
      sandbox_id: sandboxId,
      engine,
      had_prior_baseline: prior !== null,
      expires_at: new Date(Date.now() + EDIT_TTL_MS).toISOString(),
    });
  });

  app.post("/baselines/save", async (c) => {
    const body = await readJsonBody<SaveBody>(c.req.raw);
    const engine = parseEngine(body.engine);
    if (!engine) {
      return c.json(
        { error: "invalid_engine", supported: [...SUPPORTED_ENGINES] },
        400,
      );
    }

    const sandboxId = editSandboxId(engine);
    const sandbox = getSandbox(c.env.Sandbox, sandboxId);
    const store = new BaselineStore(c.env.DB);

    // Preserve the existing version tag unless the caller explicitly
    // passes a new one — re-snapshotting after an edit shouldn't erase
    // a previously-tagged version.
    const prior = await store.get(engine);
    const version =
      typeof body.version === "string" && body.version.length > 0
        ? body.version
        : prior?.version ?? null;

    let handle;
    try {
      handle = await sandbox.createBackup({
        dir: SNAPSHOT_DIR,
        name: `baseline-${engine}-${Date.now()}`,
        ttl: SNAPSHOT_TTL_SECONDS,
        localBucket: useLocalBackupBucket(c.env),
      });
    } catch (err) {
      // Tear the sandbox down even on backup failure so long-lived
      // containers don't leak.
      await safeDestroy(sandbox);
      throw err;
    }

    const now = Math.floor(Date.now() / 1000);
    await store.upsert(engine, handle, version, now);

    await safeDestroy(sandbox);

    return c.json({
      ok: true,
      engine,
      version,
      baseline_id: handle.id,
      created_at: now,
    });
  });

  return app;
}

function editSandboxId(engine: BaselineEngine): string {
  return `baseline-edit-${engine}`;
}

function parseEngine(value: unknown): BaselineEngine | null {
  if (typeof value !== "string") return null;
  return (SUPPORTED_ENGINES as readonly string[]).includes(value)
    ? (value as BaselineEngine)
    : null;
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
