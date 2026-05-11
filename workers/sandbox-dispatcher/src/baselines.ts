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

const SUPPORTED_ENGINES = ["pi", "codex", "claude"] as const;
type BaselineEngine = (typeof SUPPORTED_ENGINES)[number];

const BASE_TOOLCHAIN_CMD = [
  `mkdir -p ${SANDBOX_HOME}/.local/bin ${SANDBOX_HOME}/.npm-global`,
  `export HOME=${SANDBOX_HOME}`,
  `export PATH=${SANDBOX_HOME}/.npm-global/bin:${SANDBOX_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
  `export NPM_CONFIG_PREFIX=${SANDBOX_HOME}/.npm-global`,
  // .bashrc so /run sandboxes get PATH/HOME without extra setup
  `cat > ${SANDBOX_HOME}/.bashrc <<'BASHRC'\nexport HOME=${SANDBOX_HOME}\nexport PATH=${SANDBOX_HOME}/.npm-global/bin:${SANDBOX_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin\nexport NPM_CONFIG_PREFIX=${SANDBOX_HOME}/.npm-global\nBASHRC`,
  `cat > ${SANDBOX_HOME}/.bash_profile <<'PROF'\n[ -f ~/.bashrc ] && . ~/.bashrc\nPROF`,
].join(" && ");

const ENGINE_INSTALL_COMMANDS: Record<BaselineEngine, string> = {
  pi: [
    BASE_TOOLCHAIN_CMD,
    "npm install -g @anthropic/pi",
    "pi --version",
  ].join(" && "),
  codex: [
    BASE_TOOLCHAIN_CMD,
    "npm install -g @openai/codex",
    "codex --version",
  ].join(" && "),
  claude: [
    BASE_TOOLCHAIN_CMD,
    "npm install -g @anthropic/claude-code",
    "claude --version",
  ].join(" && "),
};

function isBaselineEngine(value: string): value is BaselineEngine {
  return (SUPPORTED_ENGINES as readonly string[]).includes(value);
}

export function buildBaselineRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/baselines/build", async (c) => {
    const body = await readJsonBody<{ engine?: unknown; version?: unknown }>(
      c.req.raw,
    );

    if (typeof body.engine !== "string" || !isBaselineEngine(body.engine)) {
      return c.json(
        { error: "invalid_engine", supported: [...SUPPORTED_ENGINES] },
        400,
      );
    }

    const engine = body.engine;
    const version =
      typeof body.version === "string" && body.version.length > 0
        ? body.version
        : null;

    const sandboxId = `baseline-build-${engine}`;
    await safeDestroy(getSandbox(c.env.Sandbox, sandboxId));
    const sandbox = getSandbox(c.env.Sandbox, sandboxId);

    try {
      const installCmd = ENGINE_INSTALL_COMMANDS[engine];
      const result = await sandbox.exec(installCmd, { timeout: 5 * 60 * 1000 });

      if (result.exitCode !== 0) {
        return c.json(
          {
            error: "build_failed",
            engine,
            exit_code: result.exitCode,
            stderr: result.stderr.slice(0, 2000),
          },
          502,
        );
      }

      const handle = await sandbox.createBackup({
        dir: SNAPSHOT_DIR,
        name: `baseline-${engine}-${Date.now()}`,
        ttl: SNAPSHOT_TTL_SECONDS,
        localBucket: useLocalBackupBucket(c.env),
      });

      const now = Math.floor(Date.now() / 1000);
      const store = new BaselineStore(c.env.DB);
      await store.upsert(engine, handle, version, now);

      return c.json({
        ok: true,
        engine,
        version,
        baseline_id: handle.id,
        created_at: now,
      });
    } finally {
      await safeDestroy(sandbox);
    }
  });

  app.get("/baselines/:engine", async (c) => {
    const engine = c.req.param("engine");
    if (!isBaselineEngine(engine)) {
      return c.json(
        { error: "invalid_engine", supported: [...SUPPORTED_ENGINES] },
        400,
      );
    }

    const store = new BaselineStore(c.env.DB);
    const summary = await store.getSummary(engine);
    if (!summary) {
      return c.json({ exists: false, engine }, 404);
    }

    return c.json({ exists: true, ...summary });
  });

  app.get("/baselines", async (c) => {
    const store = new BaselineStore(c.env.DB);
    const records = await store.list();
    return c.json({
      baselines: records.map((r) => ({
        engine: r.engine,
        baseline_id: r.handle.id,
        version: r.version,
        created_at: r.created_at,
        refreshed_at: r.refreshed_at,
      })),
    });
  });

  return app;
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
