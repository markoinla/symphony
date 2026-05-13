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
import { parseBranch, runSandboxId, shellQuote } from "../src/run";

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
  execQueue: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
  mkdirCalls: Array<{ path: string; recursive?: boolean }> = [];
  writeFileCalls: Array<{ path: string; content: string }> = [];
  writeFileError: Error | null = null;

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

  async mkdir(path: string, options?: { recursive?: boolean }) {
    this.mkdirCalls.push({ path, recursive: options?.recursive });
  }

  async writeFile(path: string, content: string) {
    if (this.writeFileError) throw this.writeFileError;
    this.writeFileCalls.push({ path, content });
  }

  async destroy() {
    this.destroyed = true;
  }
}

class FakeD1 {
  rows = new Map<
    string,
    { handle: string; version: string | null; created_at: number; refreshed_at: number | null }
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
    if (sql.startsWith("INSERT INTO engine_baselines")) {
      const [engine, handle, version, created_at, refreshed_at] = this.bindings as [
        string,
        string,
        string | null,
        number,
        number,
      ];
      this.db.rows.set(engine, { handle, version, created_at, refreshed_at });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.startsWith("DELETE FROM engine_baselines")) {
      const [engine] = this.bindings as [string];
      const had = this.db.rows.has(engine);
      this.db.rows.delete(engine);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }
    if (sql.startsWith("UPDATE engine_baselines")) {
      return { success: true, meta: { changes: 0 } };
    }
    throw new Error(`Unsupported SQL in fake D1: ${sql}`);
  }

  async first<T>() {
    const sql = this.sql.trim();
    if (!sql.startsWith("SELECT")) throw new Error(`first() called on non-SELECT: ${sql}`);
    const [key] = this.bindings as [string];
    const row = this.db.rows.get(key);
    if (!row) return null;
    return { engine: key, ...row } as unknown as T;
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

function seedBaseline(db: FakeD1, engine: string) {
  db.rows.set(engine, {
    handle: JSON.stringify({ id: `baseline-${engine}`, dir: "/home/symphony" }),
    version: null,
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
  it("restores the baseline, clones, runs pi, and destroys the sandbox", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const body = JSON.stringify({
      issue_id: "SYM-162",
      repo_url: "https://github.com/markoinla/symphony.git",
      prompt: "Add today's date to README.md.",
      engine: "pi",
      model: "anthropic/claude-sonnet-4-6",
    });

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

    expect(sandbox.restoredBackups).toEqual([{ id: "baseline-pi", dir: "/home/symphony" }]);
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

  it("returns 412 when no baseline exists for the engine", async () => {
    const app = buildApp();
    const db = new FakeD1();

    const body = JSON.stringify({
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
      error: "missing_baseline",
      engine: "pi",
    });
    expect(Object.keys(sandboxHandles)).toEqual([]);
  });

  it("embeds the request github_token in the clone URL for private repos", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-700"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" }, // mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // rm + mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // git clone
      { exitCode: 0, stdout: '{"type":"response"}', stderr: "" },
    ];
    sandboxHandles[runSandboxId("SYM-700")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-700",
      repo_url: "https://github.com/markoinla/private.git",
      prompt: "hi",
      engine: "pi",
      github_token: "ghs_tokenfromrequest",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const cloneCall = sandbox.execCalls[2]?.cmd ?? "";
    expect(cloneCall).toContain("git clone");
    expect(cloneCall).toContain(
      "https://x-access-token:ghs_tokenfromrequest@github.com/markoinla/private.git",
    );
    expect(cloneCall).not.toContain("'https://github.com/markoinla/private.git'");
  });

  it("falls back to DISPATCH_GITHUB_TOKEN when the request omits a token", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-701"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: '{"type":"response"}', stderr: "" },
    ];
    sandboxHandles[runSandboxId("SYM-701")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-701",
      repo_url: "https://github.com/markoinla/private.git",
      prompt: "hi",
      engine: "pi",
    });

    const env = makeEnv(db);
    env.DISPATCH_GITHUB_TOKEN = "ghs_envtoken";

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      env,
    );

    expect(res.status).toBe(200);
    expect(sandbox.execCalls[2]?.cmd).toContain(
      "https://x-access-token:ghs_envtoken@github.com/markoinla/private.git",
    );
  });

  it("redacts the github_token from clone_failed stderr", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-702"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      {
        exitCode: 128,
        stdout: "",
        stderr:
          "fatal: unable to access 'https://x-access-token:ghs_leak@github.com/x/y.git/': boom",
      },
    ];
    sandboxHandles[runSandboxId("SYM-702")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-702",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
      github_token: "ghs_leak",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("clone_failed");
    expect(json.stderr).not.toContain("ghs_leak");
    expect(json.stderr).toContain("***");
  });

  it("returns 502 when git clone fails and still destroys the sandbox", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-99"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" }, // mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // rm + mkdir
      { exitCode: 128, stdout: "", stderr: "fatal: repository not found" },
    ];
    sandboxHandles[runSandboxId("SYM-99")] = sandbox;

    const body = JSON.stringify({
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
    expect(sandbox.execCalls.find((c) => c.cmd.includes("pi --print"))).toBeUndefined();
  });

  it("destroys the sandbox even when the engine throws", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-1"));
    let calls = 0;
    sandbox.exec = async (cmd: string, opts?: { timeout?: number }) => {
      calls++;
      sandbox.execCalls.push({ cmd, opts });
      if (calls >= 4) {
        throw new Error("sandbox boom");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    sandboxHandles[runSandboxId("SYM-1")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-1",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(500);
    expect(sandbox.destroyed).toBe(true);
  });

  it.each([
    ["missing issue_id", { repo_url: "https://github.com/x/y.git", prompt: "p", engine: "pi" }, "invalid_issue_id"],
    ["bad repo_url scheme", { issue_id: "i", repo_url: "file:///etc/passwd", prompt: "p", engine: "pi" }, "invalid_repo_url"],
    ["repo_url with shell metachar", { issue_id: "i", repo_url: "https://x.y/z;rm -rf /.git", prompt: "p", engine: "pi" }, "invalid_repo_url"],
    ["empty prompt", { issue_id: "i", repo_url: "https://x.y/z.git", prompt: "", engine: "pi" }, "invalid_prompt"],
    ["unsupported engine", { issue_id: "i", repo_url: "https://x.y/z.git", prompt: "p", engine: "codex" }, "unsupported_engine"],
  ])("rejects %s with 400", async (_label, payload, expected) => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

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
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-1"));
    sandboxHandles[runSandboxId("SYM-1")] = sandbox;

    const body = JSON.stringify({
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

describe("POST /run (engine: claude)", () => {
  it("restores the claude baseline, writes Claude MCP config, and runs claude", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "claude");

    const sandbox = new FakeSandbox(runSandboxId("SYM-338"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: '{"type":"result","subtype":"success"}', stderr: "" },
    ];
    sandboxHandles[runSandboxId("SYM-338")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-338",
      repo_url: "https://github.com/markoinla/symphony.git",
      prompt: "Implement Claude support.",
      engine: "claude",
      model: "claude-sonnet-4-5",
      append_system_prompt: "Be concise.",
      allowed_tools: ["Bash", "Read"],
      disallowed_tools: ["WebFetch"],
      credentials: {
        anthropic_api_key: "sk-ant-test",
        mcp_servers: [
          { name: "linear", url: "https://mcp.linear.app/mcp", token: "lin_tok" },
        ],
      },
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.engine).toBe("claude");

    const mcpWrite = sandbox.writeFileCalls.find(
      (c) => c.path === "/workspace/SYM-338/.symphony-mcp-config.json",
    );
    expect(mcpWrite).toBeDefined();
    expect(JSON.parse(mcpWrite!.content)).toEqual({
      mcpServers: {
        linear: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer lin_tok" },
        },
      },
    });

    const claudeCall = sandbox.execCalls[3];
    expect(claudeCall?.cmd).toContain("export ANTHROPIC_API_KEY='sk-ant-test'");
    expect(claudeCall?.cmd).toContain("cat <<'SYMPHONY_PROMPT_EOF' | claude -p");
    expect(claudeCall?.cmd).toContain("--output-format stream-json --verbose");
    expect(claudeCall?.cmd).toContain("--permission-mode 'bypassPermissions'");
    expect(claudeCall?.cmd).toContain("--dangerously-skip-permissions");
    expect(claudeCall?.cmd).toContain(
      "--mcp-config '/workspace/SYM-338/.symphony-mcp-config.json'",
    );
    expect(claudeCall?.cmd).toContain("--model 'claude-sonnet-4-5'");
    expect(claudeCall?.cmd).toContain("--append-system-prompt 'Be concise.'");
    expect(claudeCall?.cmd).toContain("--allowed-tools 'Bash' 'Read'");
    expect(claudeCall?.cmd).toContain("--disallowed-tools 'WebFetch'");
    expect(claudeCall?.cmd).toContain("Implement Claude support.\nSYMPHONY_PROMPT_EOF");
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
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-300"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: '{"type":"response","body":"done"}', stderr: "" },
    ];
    sandboxHandles[runSandboxId("SYM-300")] = sandbox;

    const body = JSON.stringify({
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
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-301"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    sandboxHandles[runSandboxId("SYM-301")] = sandbox;

    const body = JSON.stringify({
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
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-302"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" }, // mkdir workspaceDir
      { exitCode: 0, stdout: "", stderr: "" }, // rm + mkdir workspaceDir
      { exitCode: 0, stdout: "", stderr: "" }, // git clone
      { exitCode: 0, stdout: '{"type":"response","body":"ok"}', stderr: "" }, // pi
    ];
    sandboxHandles[runSandboxId("SYM-302")] = sandbox;

    const body = JSON.stringify({
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

    // pi-mcp-adapter reads `.pi/mcp.json` from the project root (the
    // cloned workspace). Verify we mkdir + writeFile there, not to
    // `~/.config/pi` which the adapter does NOT discover.
    expect(sandbox.mkdirCalls).toContainEqual({
      path: "/workspace/SYM-302/.pi",
      recursive: true,
    });
    const mcpWrite = sandbox.writeFileCalls.find(
      (c) => c.path === "/workspace/SYM-302/.pi/mcp.json",
    );
    expect(mcpWrite).toBeDefined();
    const parsed = JSON.parse(mcpWrite!.content) as {
      mcpServers: Record<string, { url: string; auth: string; bearerToken: string }>;
    };
    expect(parsed.mcpServers.linear).toEqual({
      url: "https://mcp.linear.app",
      auth: "bearer",
      bearerToken: "lin_tok_123",
    });
  });

  it("rejects invalid credential fields with 400", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const body = JSON.stringify({
      issue_id: "SYM-303",
      repo_url: "https://github.com/x/y.git",
      prompt: "go",
      engine: "pi",
      credentials: {
        anthropic_api_key: 12345,
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
    seedBaseline(db, "pi");

    const body = JSON.stringify({
      issue_id: "SYM-304",
      repo_url: "https://github.com/x/y.git",
      prompt: "go",
      engine: "pi",
      credentials: {
        mcp_servers: [{ name: "x", url: "" }],
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
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-305"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: '{"type":"response","body":"ok"}', stderr: "" },
    ];
    sandboxHandles[runSandboxId("SYM-305")] = sandbox;

    const body = JSON.stringify({
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
    expect(sandbox.execCalls).toHaveLength(4);
    const piCall = sandbox.execCalls[3];
    expect(piCall?.cmd).not.toContain("ANTHROPIC_API_KEY");
    expect(piCall?.cmd).not.toContain("mcp.json");
    expect(sandbox.writeFileCalls).toHaveLength(0);
  });

  it("returns 502 when MCP config write fails", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-307"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    sandbox.writeFileError = new Error("Permission denied");
    sandboxHandles[runSandboxId("SYM-307")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-307",
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

    expect(res.status).toBe(502);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("mcp_config_write_failed");
    expect(json.exit_code).toBe(1);
    expect(json.stderr).toContain("Permission denied");
    expect(sandbox.destroyed).toBe(true);
    expect(sandbox.execCalls.find((c) => c.cmd.includes("pi --print"))).toBeUndefined();
  });

  it("injects all supported credential env vars", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-306"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    sandboxHandles[runSandboxId("SYM-306")] = sandbox;

    const body = JSON.stringify({
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

describe("parseBranch", () => {
  it("accepts valid branch names", () => {
    expect(parseBranch("symphony/sym-123")).toBe("symphony/sym-123");
    expect(parseBranch("main")).toBe("main");
    expect(parseBranch("feature/new.thing-2")).toBe("feature/new.thing-2");
    expect(parseBranch("a")).toBe("a");
  });

  it("treats undefined/null as opt-out (returns null)", () => {
    expect(parseBranch(undefined)).toBeNull();
    expect(parseBranch(null)).toBeNull();
  });

  it("rejects non-string types", () => {
    expect(parseBranch(123)).toBe(false);
    expect(parseBranch({})).toBe(false);
    expect(parseBranch([])).toBe(false);
  });

  it("rejects shell-injectable or git-invalid names", () => {
    expect(parseBranch("")).toBe(false);
    expect(parseBranch("--rm")).toBe(false);
    expect(parseBranch("/leading-slash")).toBe(false);
    expect(parseBranch("trailing-slash/")).toBe(false);
    expect(parseBranch(".hidden")).toBe(false);
    expect(parseBranch("branch with space")).toBe(false);
    expect(parseBranch("foo..bar")).toBe(false);
    expect(parseBranch("foo;rm -rf /")).toBe(false);
    expect(parseBranch("branch.lock")).toBe(false);
    expect(parseBranch("a".repeat(201))).toBe(false);
  });
});

describe("POST /run with branch", () => {
  it("fetches the branch when it exists on origin", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-500"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" }, // mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // rm + mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // git clone
      // ls-remote returns a ref → branch exists remotely
      {
        exitCode: 0,
        stdout: "abc123\trefs/heads/symphony/sym-500\n",
        stderr: "",
      },
      { exitCode: 0, stdout: "", stderr: "" }, // git fetch + checkout
      { exitCode: 0, stdout: '{"type":"response"}', stderr: "" }, // engine
    ];
    sandboxHandles[runSandboxId("SYM-500")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-500",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
      branch: "symphony/sym-500",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.branch).toBe("symphony/sym-500");

    const lsRemote = sandbox.execCalls[3]?.cmd ?? "";
    expect(lsRemote).toContain("git ls-remote --heads origin");
    expect(lsRemote).toContain("'symphony/sym-500'");

    const fetchCheckout = sandbox.execCalls[4]?.cmd ?? "";
    expect(fetchCheckout).toContain("git fetch origin 'symphony/sym-500'");
    expect(fetchCheckout).toContain("git checkout 'symphony/sym-500'");
  });

  it("creates the branch when it doesn't exist on origin", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-501"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" }, // mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // rm + mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // git clone
      { exitCode: 0, stdout: "", stderr: "" }, // ls-remote (empty)
      { exitCode: 0, stdout: "", stderr: "" }, // git checkout -b
      { exitCode: 0, stdout: '{"type":"response"}', stderr: "" }, // engine
    ];
    sandboxHandles[runSandboxId("SYM-501")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-501",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
      branch: "symphony/sym-501",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.branch).toBe("symphony/sym-501");

    const checkout = sandbox.execCalls[4]?.cmd ?? "";
    expect(checkout).toContain("git checkout -b 'symphony/sym-501'");
    expect(checkout).not.toContain("git fetch");
  });

  it("returns 502 branch_setup_failed when the checkout fails", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-502"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" }, // mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // rm + mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // git clone
      { exitCode: 0, stdout: "", stderr: "" }, // ls-remote (empty)
      { exitCode: 128, stdout: "", stderr: "checkout boom" }, // checkout fails
    ];
    sandboxHandles[runSandboxId("SYM-502")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-502",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
      branch: "symphony/sym-502",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("branch_setup_failed");
    expect(json.exit_code).toBe(128);
    expect(json.stderr).toContain("checkout boom");
    expect(sandbox.destroyed).toBe(true);
    expect(
      sandbox.execCalls.find((c) => c.cmd.includes("pi --print")),
    ).toBeUndefined();
  });

  it("rejects invalid branch names with 400", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const body = JSON.stringify({
      issue_id: "SYM-503",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
      branch: "--rm",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("invalid_branch");
  });

  it("falls back to current behavior when branch is omitted", async () => {
    // Same shape as the original happy-path test — verifies that adding
    // the `branch` field is non-breaking for callers that don't pass it.
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-504"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" }, // mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // rm + mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // git clone
      { exitCode: 0, stdout: '{"type":"response"}', stderr: "" }, // engine
    ];
    sandboxHandles[runSandboxId("SYM-504")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-504",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.branch).toBeNull();
    expect(sandbox.execCalls).toHaveLength(4);
    expect(
      sandbox.execCalls.find((c) => c.cmd.includes("git ls-remote")),
    ).toBeUndefined();
  });
});
