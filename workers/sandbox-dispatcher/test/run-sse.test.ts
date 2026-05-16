import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sandboxHandles: Record<string, FakeSandbox> = {};

vi.mock("@cloudflare/sandbox", () => {
  return {
    getSandbox: vi.fn((_ns: unknown, id: string) => {
      if (!sandboxHandles[id]) {
        sandboxHandles[id] = new FakeSandbox(id);
      }
      return sandboxHandles[id];
    }),
    proxyToSandbox: vi.fn(async () => null),
  };
});

import { buildApp, type Env } from "../src/index";
import { computeSignature } from "../src/hmac";
import { runSandboxId } from "../src/run";

const SECRET = "run-sse-test-secret";

// Mirrors the dispatcher's PRELUDE_PREFIX. Pinned here on purpose — it
// is a wire-format constant the linear-agent worker also depends on.
const PRELUDE_PREFIX = "__SYMPHONY_EVENT__ ";

function preludeLine(text: string): string {
  return `${PRELUDE_PREFIX}${JSON.stringify({ type: "thought", text })}`;
}

type FakeProcStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "error";

/**
 * The dispatcher launches the engine as a detached background process
 * whose stdout is the process log. The prelude (`printf '%s\n' …`) is
 * prepended to the engine command, so the process log starts with the
 * dispatcher's setup-narration lines, then the engine's own output.
 */
class FakeSandbox {
  constructor(public id: string) {}

  destroyed = false;
  restoredBackups: Array<{ id: string; dir: string }> = [];
  execCalls: string[] = [];
  execQueue: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
  mkdirCalls: Array<{ path: string; recursive?: boolean }> = [];
  writeFileCalls: Array<{ path: string; content: string }> = [];
  writeFileError: Error | null = null;

  // Background-process model.
  startProcessCalls: Array<{ command: string; processId?: string }> = [];
  // Raw stdout the engine emits, after the dispatcher's prelude lines.
  engineStdout = "";
  procStatus: FakeProcStatus = "completed";
  procExitCode = 0;
  private procLog = "";
  private hasProcess = false;

  async restoreBackup(handle: { id: string; dir: string }) {
    this.restoredBackups.push({ id: handle.id, dir: handle.dir });
    return { success: true, dir: handle.dir, id: handle.id };
  }

  async exec(cmd: string, _opts?: { timeout?: number }) {
    this.execCalls.push(cmd);
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

  async startProcess(
    command: string,
    options?: { processId?: string; autoCleanup?: boolean; timeout?: number },
  ) {
    this.startProcessCalls.push({ command, processId: options?.processId });
    const prelude = extractPreludeLines(command);
    const parts = [...prelude];
    if (this.engineStdout.length > 0) parts.push(this.engineStdout);
    this.procLog = parts.join("\n");
    if (this.procLog.length > 0 && !this.procLog.endsWith("\n")) {
      this.procLog += "\n";
    }
    this.hasProcess = true;
    return {
      id: options?.processId ?? "proc",
      command,
      status: this.procStatus,
      startTime: new Date(),
    };
  }

  /** Seed a finished/running process without going through startProcess
   *  — used by /run/attach tests, which never call startProcess. */
  seedProcess(log: string, status: FakeProcStatus, exitCode: number) {
    this.procLog = log;
    this.procStatus = status;
    this.procExitCode = exitCode;
    this.hasProcess = true;
  }

  async getProcess(_id: string) {
    if (!this.hasProcess) return null;
    return { status: this.procStatus, exitCode: this.procExitCode };
  }

  async getProcessLogs(id: string) {
    return { stdout: this.procLog, stderr: "", processId: id };
  }

  async destroy() {
    this.destroyed = true;
  }
}

/**
 * Recover the prelude lines the dispatcher prepended to the engine
 * command (`printf '%s\n' '<l1>' '<l2>' … ; <engine cmd>`). The first
 * single-quoted token is printf's `%s\n` format; the rest are prelude
 * event lines.
 */
function extractPreludeLines(command: string): string[] {
  if (!command.startsWith("printf ")) return [];
  const sep = command.indexOf(" ; ");
  const printfPart = sep === -1 ? command : command.slice(0, sep);
  const tokens = [...printfPart.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
  return tokens.slice(1);
}

async function* parseSSEStreamImpl<T>(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const rawLine of frame.split("\n")) {
        if (rawLine.startsWith("data:")) {
          const json = rawLine.slice(5).trim();
          if (json.length > 0) {
            try {
              yield JSON.parse(json) as T;
            } catch {
              // skip malformed
            }
          }
        }
      }
    }
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
    return { success: true, meta: { changes: 0 } };
  }
  async first<T>() {
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
  headers.set("Accept", "text/event-stream");
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

async function consumeSseFrames(
  res: Response,
): Promise<Array<Record<string, unknown>>> {
  expect(res.body).not.toBeNull();
  const events: Array<Record<string, unknown>> = [];
  for await (const ev of parseSSEStreamImpl<Record<string, unknown>>(
    res.body as ReadableStream<Uint8Array>,
  )) {
    events.push(ev);
  }
  return events;
}

beforeEach(() => {
  for (const k of Object.keys(sandboxHandles)) delete sandboxHandles[k];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /run (Accept: text/event-stream)", () => {
  it("emits normalized events for pi stdout and terminates with a result frame", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-200"));
    sandbox.engineStdout = [
      '{"type":"session","id":"x"}',
      '{"type":"agent_start"}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done — opened PR #123."}]}}',
      '{"type":"agent_end"}',
    ].join("\n");
    sandboxHandles[runSandboxId("SYM-200")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-200",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const events = await consumeSseFrames(res);

    expect(events.map((e) => e.type)).toEqual([
      "thought",
      "thought",
      "thought",
      "thought",
      "assistant_msg",
      "turn_end",
      "result",
    ]);
    expect(events[0]).toMatchObject({
      type: "thought",
      text: expect.stringContaining("Spinning up a sandbox"),
    });
    expect(events[1]).toMatchObject({
      type: "thought",
      text: expect.stringContaining("Configuring environment"),
    });
    expect(events[2]).toMatchObject({
      type: "thought",
      text: expect.stringContaining("Cloning"),
    });
    expect(events[3]).toMatchObject({
      type: "thought",
      text: expect.stringContaining("Calling model"),
    });
    expect(events[4]).toMatchObject({
      type: "assistant_msg",
      text: "Done — opened PR #123.",
    });
    expect(events[5]).toMatchObject({ type: "turn_end", turn: 1, reason: "completed" });
    expect(events[6]).toMatchObject({ type: "result", exit_code: 0 });
    expect(events[6]?.duration_ms).toEqual(expect.any(Number));
    // The engine is detached: a /run stream does NOT destroy the sandbox.
    expect(sandbox.destroyed).toBe(false);
    // The engine ran as a per-turn background process.
    expect(sandbox.startProcessCalls).toHaveLength(1);
    expect(sandbox.startProcessCalls[0]!.processId).toContain(
      "engine-sym-200-t1",
    );
  });

  it("lets the claude adapter emit turn_end without adding a synthetic one", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-338"));
    sandbox.engineStdout = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Done"}]}}',
      '{"type":"result","subtype":"success"}',
    ].join("\n");
    sandboxHandles[runSandboxId("SYM-338")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-338",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "claude",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const events = await consumeSseFrames(res);
    expect(events.map((e) => e.type)).toEqual([
      "thought",
      "thought",
      "thought",
      "thought",
      "assistant_msg",
      "turn_end",
      "result",
    ]);
    expect(events.filter((e) => e.type === "turn_end")).toEqual([
      { type: "turn_end", turn: 1, reason: "completed" },
    ]);
  });

  it("writes MCP config and injects env vars in streaming mode", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-310"));
    sandbox.engineStdout = [
      '{"type":"agent_start"}',
      '{"type":"agent_end"}',
    ].join("\n");
    sandboxHandles[runSandboxId("SYM-310")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-310",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
      credentials: {
        anthropic_api_key: "sk-ant-stream",
        mcp_servers: [
          { name: "test-mcp", url: "https://mcp.example.com", token: "tok_abc" },
        ],
      },
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const events = await consumeSseFrames(res);
    expect(events.map((e) => e.type)).toEqual([
      "thought",
      "thought",
      "thought",
      "thought",
      "turn_end",
      "result",
    ]);

    const mcpWrite = sandbox.writeFileCalls.find(
      (c) => c.path === "/workspace/SYM-310/.pi/mcp.json",
    );
    expect(mcpWrite).toBeDefined();
    const parsed = JSON.parse(mcpWrite!.content) as {
      mcpServers: Record<string, { url: string; auth: string; bearerToken: string }>;
    };
    expect(parsed.mcpServers["test-mcp"]).toEqual({
      url: "https://mcp.example.com",
      auth: "bearer",
      bearerToken: "tok_abc",
    });
    // The injected ANTHROPIC_API_KEY reaches the engine via the process
    // command, which is passed to startProcess.
    expect(sandbox.startProcessCalls[0]!.command).toContain(
      "ANTHROPIC_API_KEY",
    );
    expect(sandbox.destroyed).toBe(false);
  });

  it("redacts repo URL in clone thought when it contains a token", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-311"));
    sandbox.engineStdout = '{"type":"agent_end"}';
    sandboxHandles[runSandboxId("SYM-311")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-311",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const events = await consumeSseFrames(res);
    const cloneThought = events.find(
      (e) =>
        e.type === "thought" &&
        typeof e.text === "string" &&
        e.text.includes("Cloning"),
    );
    expect(cloneThought).toBeDefined();
    expect((cloneThought as { text: string }).text).toContain(
      "github.com/x/y.git",
    );
  });

  it("emits an error event then result when the baseline is missing", async () => {
    const app = buildApp();
    const db = new FakeD1();

    const body = JSON.stringify({
      issue_id: "SYM-X",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const events = await consumeSseFrames(res);
    // Setup failed before a process started, so there's no prelude — the
    // stream is just the error + a terminal result frame.
    expect(events.map((e) => e.type)).toEqual(["error", "result"]);
    expect((events[0] as { message: string }).message).toContain(
      "missing_baseline",
    );
    expect((events[1] as { exit_code: number }).exit_code).not.toBe(0);
  });

  it("embeds the github_token in the clone URL and redacts it from clone_failed", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-703"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      {
        exitCode: 128,
        stdout: "",
        stderr:
          "fatal: unable to access 'https://x-access-token:ghs_secret@github.com/x/y.git/': nope",
      },
    ];
    sandboxHandles[runSandboxId("SYM-703")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-703",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
      github_token: "ghs_secret",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const events = await consumeSseFrames(res);

    const cloneCmd = sandbox.execCalls.find((c) => c.includes("git clone"));
    expect(cloneCmd).toBeDefined();
    expect(cloneCmd).toContain(
      "https://x-access-token:ghs_secret@github.com/x/y.git",
    );

    const errorEvent = events.find((e) => e.type === "error") as
      | { message: string }
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toContain("clone_failed");
    expect(errorEvent!.message).not.toContain("ghs_secret");
    expect(errorEvent!.message).toContain("***");
    // No background process is started when the clone fails.
    expect(sandbox.startProcessCalls).toHaveLength(0);
  });

  it("emits an error event then result when git clone fails", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-99"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 128, stdout: "", stderr: "fatal: repository not found" },
    ];
    sandboxHandles[runSandboxId("SYM-99")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-99",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const events = await consumeSseFrames(res);
    expect(events.map((e) => e.type)).toEqual(["error", "result"]);
    expect((events[0] as { message: string }).message).toContain(
      "clone_failed",
    );
    expect((events[1] as { exit_code: number }).exit_code).not.toBe(0);
    expect(sandbox.destroyed).toBe(false);
  });

  it("emits error and result when MCP config write fails", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-312"));
    sandbox.writeFileError = new Error("Permission denied");
    sandboxHandles[runSandboxId("SYM-312")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-312",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
      credentials: {
        mcp_servers: [
          { name: "test-mcp", url: "https://mcp.example.com", token: "tok_abc" },
        ],
      },
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const events = await consumeSseFrames(res);
    expect(events.map((e) => e.type)).toEqual(["error", "result"]);
    expect((events[0] as { message: string }).message).toContain(
      "mcp_config_write_failed",
    );
    expect(sandbox.startProcessCalls).toHaveLength(0);
  });

  it("emits 'Creating new branch' thought when the branch is absent on origin", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-510"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" }, // mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // rm + mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // git clone
      { exitCode: 0, stdout: "", stderr: "" }, // ls-remote (empty)
      { exitCode: 0, stdout: "", stderr: "" }, // git checkout -b
    ];
    sandbox.engineStdout = '{"type":"agent_end"}';
    sandboxHandles[runSandboxId("SYM-510")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-510",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
      branch: "symphony/sym-510",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const events = await consumeSseFrames(res);
    const thoughts = events
      .filter((e) => e.type === "thought")
      .map((e) => (e as { text: string }).text);

    const cloningIdx = thoughts.findIndex((t) => t.includes("Cloning"));
    expect(cloningIdx).toBeGreaterThanOrEqual(0);
    expect(thoughts[cloningIdx + 1]).toBe(
      "Creating new branch symphony/sym-510…",
    );
  });

  it("emits 'Checking out existing branch' thought when the branch is on origin", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-511"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" }, // mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // rm + mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // git clone
      {
        exitCode: 0,
        stdout: "abc123\trefs/heads/symphony/sym-511\n",
        stderr: "",
      }, // ls-remote (hit)
      { exitCode: 0, stdout: "", stderr: "" }, // git fetch + checkout
    ];
    sandbox.engineStdout = '{"type":"agent_end"}';
    sandboxHandles[runSandboxId("SYM-511")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-511",
      repo_url: "https://github.com/x/y.git",
      prompt: "hi",
      engine: "pi",
      branch: "symphony/sym-511",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const events = await consumeSseFrames(res);
    const thoughts = events
      .filter((e) => e.type === "thought")
      .map((e) => (e as { text: string }).text);

    const cloningIdx = thoughts.findIndex((t) => t.includes("Cloning"));
    expect(cloningIdx).toBeGreaterThanOrEqual(0);
    expect(thoughts[cloningIdx + 1]).toBe(
      "Checking out existing branch symphony/sym-511…",
    );
  });
});

describe("POST /run/attach", () => {
  it("replays the full event stream when cursor is 0", async () => {
    const app = buildApp();
    const db = new FakeD1();

    const sandbox = new FakeSandbox(runSandboxId("SYM-900"));
    sandbox.seedProcess(
      [
        preludeLine("Spinning up a sandbox…"),
        preludeLine("Configuring environment…"),
        preludeLine("Calling model…"),
      ].join("\n") + "\n",
      "completed",
      0,
    );
    sandboxHandles[runSandboxId("SYM-900")] = sandbox;

    const body = JSON.stringify({
      issue_id: "SYM-900",
      turn: 1,
      cursor: 0,
      engine: "pi",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run/attach", {
        method: "POST",
        body,
      }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const events = await consumeSseFrames(res);
    expect(events.map((e) => e.type)).toEqual([
      "thought",
      "thought",
      "thought",
      "turn_end",
      "result",
    ]);
    // Re-attaching must not destroy the sandbox.
    expect(sandbox.destroyed).toBe(false);
  });

  it("skips the first `cursor` events on re-attach", async () => {
    const app = buildApp();
    const db = new FakeD1();

    const sandbox = new FakeSandbox(runSandboxId("SYM-901"));
    sandbox.seedProcess(
      [
        preludeLine("Spinning up a sandbox…"),
        preludeLine("Configuring environment…"),
        preludeLine("Calling model…"),
      ].join("\n") + "\n",
      "completed",
      0,
    );
    sandboxHandles[runSandboxId("SYM-901")] = sandbox;

    // The caller already consumed the 3 prelude thoughts on a prior
    // attempt; cursor=3 resumes after them.
    const body = JSON.stringify({
      issue_id: "SYM-901",
      turn: 1,
      cursor: 3,
      engine: "pi",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run/attach", {
        method: "POST",
        body,
      }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const events = await consumeSseFrames(res);
    // Only the synthetic terminal frames remain.
    expect(events.map((e) => e.type)).toEqual(["turn_end", "result"]);
    expect(events[1]).toMatchObject({ type: "result", exit_code: 0 });
  });

  it("emits an error + result when no process exists for the issue/turn", async () => {
    const app = buildApp();
    const db = new FakeD1();

    // FakeSandbox with no seeded process — getProcess returns null.
    sandboxHandles[runSandboxId("SYM-902")] = new FakeSandbox(
      runSandboxId("SYM-902"),
    );

    const body = JSON.stringify({
      issue_id: "SYM-902",
      turn: 1,
      cursor: 0,
      engine: "pi",
    });

    const res = await app.fetch(
      await signedRequest("https://example/run/attach", {
        method: "POST",
        body,
      }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const events = await consumeSseFrames(res);
    expect(events.map((e) => e.type)).toEqual(["error", "result"]);
    expect((events[0] as { message: string }).message).toContain(
      "process_not_found",
    );
  });
});
