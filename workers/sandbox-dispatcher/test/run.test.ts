import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sandboxHandles: Record<string, FakeSandbox> = {};
let proxyToSandboxImpl: () => Promise<Response | null> = async () => null;

vi.mock("@cloudflare/sandbox", () => {
  return {
    getSandbox: vi.fn((_ns: unknown, id: string) => {
      if (!sandboxHandles[id]) {
        sandboxHandles[id] = new FakeSandbox(id);
      }
      return sandboxHandles[id];
    }),
    proxyToSandbox: vi.fn(async () => proxyToSandboxImpl()),
  };
});

import { buildApp, type Env } from "../src/index";
import { computeSignature } from "../src/hmac";
import { runSandboxId, shellQuote } from "../src/run";

const SECRET = "run-test-secret";

interface ExecCall {
  cmd: string;
  opts?: { timeout?: number };
}

class FakeSandbox {
  constructor(public id: string) {}

  destroyed = false;
  restoredBackups: Array<{ id: string; dir: string }> = [];
  execCalls: ExecCall[] = [];

  // Each test can install a queue of canned exec results. If the queue is
  // empty we return success-with-empty-output, which is correct for the
  // "happy path" prep commands (mkdir, rm -rf, git clone).
  execQueue: Array<{ exitCode: number; stdout: string; stderr: string }> = [];

  async restoreBackup(handle: { id: string; dir: string }) {
    this.restoredBackups.push({ id: handle.id, dir: handle.dir });
    return { success: true, dir: handle.dir, id: handle.id };
  }

  async exec(cmd: string, opts?: { timeout?: number }) {
    this.execCalls.push({ cmd, opts });
    const next = this.execQueue.shift();
    if (next) return next;
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async destroy() {
    this.destroyed = true;
  }
}

class FakeD1 {
  rows = new Map<
    string,
    { handle: string; created_at: number; refreshed_at: number | null }
  >();

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
  private bindings: unknown[] = [];

  constructor(private db: FakeD1, private sql: string) {}

  bind(...values: unknown[]) {
    this.bindings = values;
    return this;
  }

  async run() {
    const sql = this.sql.trim();
    if (sql.startsWith("INSERT INTO auth_backups")) {
      const [scope, handle, created_at, refreshed_at] = this.bindings as [
        string,
        string,
        number,
        number,
      ];
      this.db.rows.set(scope, { handle, created_at, refreshed_at });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.startsWith("DELETE FROM auth_backups")) {
      const [scope] = this.bindings as [string];
      const had = this.db.rows.has(scope);
      this.db.rows.delete(scope);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }
    if (sql.startsWith("UPDATE auth_backups")) {
      return { success: true, meta: { changes: 0 } };
    }
    throw new Error(`Unsupported SQL in fake D1: ${sql}`);
  }

  async first<T>() {
    const sql = this.sql.trim();
    if (!sql.startsWith("SELECT")) throw new Error(`first() called on non-SELECT: ${sql}`);
    const [scope] = this.bindings as [string];
    const row = this.db.rows.get(scope);
    if (!row) return null;
    return { scope, ...row } as unknown as T;
  }

  async all<T>() {
    return { success: true, results: [] as T[] };
  }
}

function makeEnv(db: FakeD1): Env {
  return {
    DISPATCH_HMAC_SECRET: SECRET,
    Sandbox: {} as Env["Sandbox"],
    BACKUP_BUCKET: {} as R2Bucket,
    DB: db as unknown as D1Database,
    USE_LOCAL_BACKUP_BUCKET: "true",
  };
}

async function signedRequest(
  url: string,
  init: RequestInit & { body?: string } = {},
): Promise<Request> {
  const body = init.body ?? "";
  const sig = await computeSignature(SECRET, body);
  const headers = new Headers(init.headers ?? {});
  headers.set("X-Symphony-Signature", sig);
  if (body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(url, { ...init, headers });
}

function getSandboxForId(id: string): FakeSandbox {
  const sandbox = sandboxHandles[id];
  if (!sandbox) throw new Error(`expected fake sandbox to exist for id=${id}`);
  return sandbox;
}

function seedBackup(db: FakeD1, scope: string) {
  db.rows.set(scope, {
    handle: JSON.stringify({ id: `backup-${scope}`, dir: "/root" }),
    created_at: 1_700_000_000,
    refreshed_at: 1_700_000_000,
  });
}

beforeEach(() => {
  for (const k of Object.keys(sandboxHandles)) delete sandboxHandles[k];
  proxyToSandboxImpl = async () => null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /run (engine: pi)", () => {
  it("restores the snapshot, clones, runs pi, and destroys the sandbox", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBackup(db, "alice");

    const body = JSON.stringify({
      scope: "alice",
      issue_id: "SYM-162",
      repo_url: "https://github.com/markoinla/symphony.git",
      prompt: "Add today's date to README.md.",
      engine: "pi",
      model: "anthropic/claude-sonnet-4-6",
    });

    // Pre-create the sandbox so we can pre-load exec results: mkdir, rm,
    // git clone (success), then the engine command itself.
    const sandbox = new FakeSandbox(runSandboxId("SYM-162"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" }, // mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // rm + mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // git clone
      { exitCode: 0, stdout: '{"type":"response","body":"done"}', stderr: "" },
    ];
    sandboxHandles[runSandboxId("SYM-162")] = sandbox;

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.engine).toBe("pi");
    expect(json.exit_code).toBe(0);
    expect(json.stdout).toContain('"type":"response"');
    expect(typeof json.duration_ms).toBe("number");

    expect(sandbox.restoredBackups).toEqual([{ id: "backup-alice", dir: "/root" }]);
    expect(sandbox.execCalls).toHaveLength(4);
    expect(sandbox.execCalls[0]?.cmd).toMatch(/mkdir -p '\/workspace\/SYM-162'/);
    expect(sandbox.execCalls[2]?.cmd).toContain("git clone");
    expect(sandbox.execCalls[2]?.cmd).toContain("https://github.com/markoinla/symphony.git");

    const piCall = sandbox.execCalls[3];
    expect(piCall?.cmd).toContain("pi --print --mode json");
    expect(piCall?.cmd).toContain("--model 'anthropic/claude-sonnet-4-6'");
    expect(piCall?.cmd).toContain("'Add today'\\''s date to README.md.'");
    expect(piCall?.opts?.timeout).toBe(10 * 60 * 1000);

    expect(sandbox.destroyed).toBe(true);
  });

  it("returns 412 when no snapshot exists for the scope", async () => {
    const app = buildApp();
    const db = new FakeD1();

    const body = JSON.stringify({
      scope: "ghost",
      issue_id: "SYM-1",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({
      error: "missing_auth_backup",
      scope: "ghost",
    });
    // No sandbox should have been created.
    expect(Object.keys(sandboxHandles)).toEqual([]);
  });

  it("returns 502 when git clone fails and still destroys the sandbox", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBackup(db, "alice");

    const sandbox = new FakeSandbox(runSandboxId("SYM-99"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" }, // mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // rm + mkdir
      { exitCode: 128, stdout: "", stderr: "fatal: repository not found" },
    ];
    sandboxHandles[runSandboxId("SYM-99")] = sandbox;

    const body = JSON.stringify({
      scope: "alice",
      issue_id: "SYM-99",
      repo_url: "https://github.com/missing/missing.git",
      prompt: "do a thing",
      engine: "pi",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("clone_failed");
    expect(json.exit_code).toBe(128);
    expect(json.stderr).toContain("repository not found");
    expect(sandbox.destroyed).toBe(true);
    // Engine command should not have run.
    expect(sandbox.execCalls.find((c) => c.cmd.includes("pi --print"))).toBeUndefined();
  });

  it("destroys the sandbox even when the engine throws", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBackup(db, "alice");

    const sandbox = new FakeSandbox(runSandboxId("SYM-1"));
    let calls = 0;
    sandbox.exec = async (cmd: string, opts?: { timeout?: number }) => {
      calls++;
      sandbox.execCalls.push({ cmd, opts });
      // First three exec calls succeed (mkdir, rm, clone). Engine call (4)
      // throws.
      if (calls >= 4) {
        throw new Error("sandbox boom");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    sandboxHandles[runSandboxId("SYM-1")] = sandbox;

    const body = JSON.stringify({
      scope: "alice",
      issue_id: "SYM-1",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    // Hono's default error handler converts thrown errors to 500.
    expect(res.status).toBe(500);
    expect(sandbox.destroyed).toBe(true);
  });

  it.each([
    ["missing scope", { issue_id: "SYM-1", repo_url: "https://github.com/x/y.git", prompt: "p", engine: "pi" }, "invalid_scope"],
    ["missing issue_id", { scope: "a", repo_url: "https://github.com/x/y.git", prompt: "p", engine: "pi" }, "invalid_issue_id"],
    ["bad repo_url scheme", { scope: "a", issue_id: "i", repo_url: "file:///etc/passwd", prompt: "p", engine: "pi" }, "invalid_repo_url"],
    ["repo_url with shell metachar", { scope: "a", issue_id: "i", repo_url: "https://x.y/z;rm -rf /.git", prompt: "p", engine: "pi" }, "invalid_repo_url"],
    ["empty prompt", { scope: "a", issue_id: "i", repo_url: "https://x.y/z.git", prompt: "", engine: "pi" }, "invalid_prompt"],
    ["unsupported engine", { scope: "a", issue_id: "i", repo_url: "https://x.y/z.git", prompt: "p", engine: "claude" }, "unsupported_engine"],
  ])("rejects %s with 400", async (_label, payload, expected) => {
    const app = buildApp();
    const db = new FakeD1();
    seedBackup(db, "a");

    const res = await app.fetch(
      await signedRequest("https://example/run", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
      makeEnv(db),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe(expected);
  });

  it("clamps timeout_ms to MAX_TIMEOUT_MS", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBackup(db, "alice");

    const sandbox = new FakeSandbox(runSandboxId("SYM-1"));
    sandboxHandles[runSandboxId("SYM-1")] = sandbox;

    const body = JSON.stringify({
      scope: "alice",
      issue_id: "SYM-1",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
      timeout_ms: 999_999_999,
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const piCall = sandbox.execCalls.find((c) => c.cmd.includes("pi --print"));
    expect(piCall?.opts?.timeout).toBe(30 * 60 * 1000);
  });
});

describe("POST /run/stop", () => {
  it("destroys the per-issue sandbox and returns ok", async () => {
    const app = buildApp();
    const db = new FakeD1();

    const sandbox = new FakeSandbox(runSandboxId("SYM-7"));
    sandboxHandles[runSandboxId("SYM-7")] = sandbox;

    const res = await app.fetch(
      await signedRequest("https://example/run/stop", {
        method: "POST",
        body: JSON.stringify({ issue_id: "SYM-7" }),
      }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, issue_id: "SYM-7" });
    expect(sandbox.destroyed).toBe(true);
  });
});

describe("shellQuote", () => {
  it.each([
    ["plain", "'plain'"],
    ["with spaces", "'with spaces'"],
    ["it's", "'it'\\''s'"],
    ["a$b`c", "'a$b`c'"],
    ["", "''"],
  ])("quotes %j", (input, expected) => {
    expect(shellQuote(input)).toBe(expected);
  });
});

describe("POST /run with credentials", () => {
  it("injects credential env vars into the engine command", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBackup(db, "alice");

    const sandbox = new FakeSandbox(runSandboxId("SYM-300"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" }, // mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // rm + mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // git clone
      { exitCode: 0, stdout: '{"type":"response","body":"done"}', stderr: "" }, // engine
    ];
    sandboxHandles[runSandboxId("SYM-300")] = sandbox;

    const body = JSON.stringify({
      scope: "alice",
      issue_id: "SYM-300",
      repo_url: "https://github.com/x/y.git",
      prompt: "do something",
      engine: "pi",
      credentials: {
        anthropic_api_key: "sk-ant-test123",
        openai_api_key: "sk-openai-test456",
      },
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const piCall = sandbox.execCalls.find((c) => c.cmd.includes("pi --print"));
    expect(piCall?.cmd).toContain("export ANTHROPIC_API_KEY='sk-ant-test123'");
    expect(piCall?.cmd).toContain("export OPENAI_API_KEY='sk-openai-test456'");
  });

  it("shell-quotes credential values containing single quotes", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBackup(db, "alice");

    const sandbox = new FakeSandbox(runSandboxId("SYM-301"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    sandboxHandles[runSandboxId("SYM-301")] = sandbox;

    const body = JSON.stringify({
      scope: "alice",
      issue_id: "SYM-301",
      repo_url: "https://github.com/x/y.git",
      prompt: "go",
      engine: "pi",
      credentials: {
        anthropic_api_key: "key'with'quotes",
      },
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const piCall = sandbox.execCalls.find((c) => c.cmd.includes("pi --print"));
    expect(piCall?.cmd).toContain("export ANTHROPIC_API_KEY='key'\\''with'\\''quotes'");
  });

  it("writes MCP config file when mcp_servers are provided", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBackup(db, "alice");

    const sandbox = new FakeSandbox(runSandboxId("SYM-302"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" }, // mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // rm + mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // git clone
      { exitCode: 0, stdout: "", stderr: "" }, // writeMcpConfig
      { exitCode: 0, stdout: '{"type":"response","body":"ok"}', stderr: "" }, // engine
    ];
    sandboxHandles[runSandboxId("SYM-302")] = sandbox;

    const body = JSON.stringify({
      scope: "alice",
      issue_id: "SYM-302",
      repo_url: "https://github.com/x/y.git",
      prompt: "go",
      engine: "pi",
      credentials: {
        mcp_servers: [
          { name: "linear", url: "https://mcp.linear.app", token: "lin_tok_123" },
        ],
      },
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const mcpCall = sandbox.execCalls.find((c) => c.cmd.includes("mcp.json"));
    expect(mcpCall).toBeDefined();
    expect(mcpCall?.cmd).toContain("mkdir -p '/home/symphony/.config/pi'");
    expect(mcpCall?.cmd).toContain("mcp.json");
    // Verify the config JSON is written (via printf '%s')
    expect(mcpCall?.cmd).toContain("linear");
    expect(mcpCall?.cmd).toContain("Bearer lin_tok_123");
  });

  it("rejects invalid credential fields with 400", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBackup(db, "alice");

    const body = JSON.stringify({
      scope: "alice",
      issue_id: "SYM-303",
      repo_url: "https://github.com/x/y.git",
      prompt: "go",
      engine: "pi",
      credentials: {
        anthropic_api_key: 12345, // not a string
      },
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("invalid_credentials.anthropic_api_key");
  });

  it("rejects invalid mcp_servers entries with 400", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBackup(db, "alice");

    const body = JSON.stringify({
      scope: "alice",
      issue_id: "SYM-304",
      repo_url: "https://github.com/x/y.git",
      prompt: "go",
      engine: "pi",
      credentials: {
        mcp_servers: [{ name: "x", url: "" }], // empty url
      },
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("invalid_credentials.mcp_servers[0].url");
  });

  it("passes null credentials when field is absent (backward compatible)", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBackup(db, "alice");

    const sandbox = new FakeSandbox(runSandboxId("SYM-305"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: '{"type":"response","body":"ok"}', stderr: "" },
    ];
    sandboxHandles[runSandboxId("SYM-305")] = sandbox;

    const body = JSON.stringify({
      scope: "alice",
      issue_id: "SYM-305",
      repo_url: "https://github.com/x/y.git",
      prompt: "go",
      engine: "pi",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    // Should be exactly 4 exec calls (mkdir, rm, clone, engine) — no MCP config write
    expect(sandbox.execCalls).toHaveLength(4);
    const piCall = sandbox.execCalls[3];
    expect(piCall?.cmd).not.toContain("ANTHROPIC_API_KEY");
    expect(piCall?.cmd).not.toContain("mcp.json");
  });

  it("injects all supported credential env vars", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBackup(db, "alice");

    const sandbox = new FakeSandbox(runSandboxId("SYM-306"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    sandboxHandles[runSandboxId("SYM-306")] = sandbox;

    const body = JSON.stringify({
      scope: "alice",
      issue_id: "SYM-306",
      repo_url: "https://github.com/x/y.git",
      prompt: "go",
      engine: "pi",
      credentials: {
        cloudflare_account_id: "cf-acct-123",
        cloudflare_api_token: "cf-tok-456",
        anthropic_api_key: "sk-ant-789",
        openai_api_key: "sk-oai-abc",
        github_token: "ghp_def",
      },
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const piCall = sandbox.execCalls.find((c) => c.cmd.includes("pi --print"));
    expect(piCall?.cmd).toContain("export CLOUDFLARE_ACCOUNT_ID='cf-acct-123'");
    expect(piCall?.cmd).toContain("export CLOUDFLARE_API_TOKEN='cf-tok-456'");
    expect(piCall?.cmd).toContain("export ANTHROPIC_API_KEY='sk-ant-789'");
    expect(piCall?.cmd).toContain("export OPENAI_API_KEY='sk-oai-abc'");
    expect(piCall?.cmd).toContain("export GITHUB_TOKEN='ghp_def'");
  });
});

describe("runSandboxId", () => {
  it("sanitizes Linear-style identifiers and lowercases", () => {
    expect(runSandboxId("SYM-162")).toBe("run-sym-162");
    expect(runSandboxId("alice:proj")).toBe("run-alice-proj");
  });
});
