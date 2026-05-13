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
    parseSSEStream: vi.fn(parseSSEStreamImpl),
  };
});

import { buildApp, type Env } from "../src/index";
import { computeSignature } from "../src/hmac";
import { runSandboxId } from "../src/run";

const SECRET = "run-sse-test-secret";

interface FakeExecEvent {
  type: "stdout" | "stderr" | "complete" | "error";
  data?: string;
  exitCode?: number;
  error?: string;
}

class FakeSandbox {
  constructor(public id: string) {}

  destroyed = false;
  restoredBackups: Array<{ id: string; dir: string }> = [];
  execCalls: string[] = [];
  execQueue: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
  streamScript: FakeExecEvent[] = [];
  mkdirCalls: Array<{ path: string; recursive?: boolean }> = [];
  writeFileCalls: Array<{ path: string; content: string }> = [];
  writeFileError: Error | null = null;

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

  async execStream(
    _cmd: string,
    _opts?: { timeout?: number },
  ): Promise<ReadableStream<Uint8Array>> {
    const script = this.streamScript;
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const ev of script) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        }
        controller.close();
      },
    });
  }

  async destroy() {
    this.destroyed = true;
  }
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
    sandbox.streamScript = [
      { type: "stdout", data: '{"type":"session","id":"x"}\n' },
      { type: "stdout", data: '{"type":"agent_start"}\n' },
      {
        type: "stdout",
        data:
          '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done — ',
      },
      { type: "stdout", data: 'opened PR #123."}]}}\n' },
      { type: "stdout", data: '{"type":"agent_end"}\n' },
      { type: "complete", exitCode: 0 },
    ];
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
    expect(sandbox.destroyed).toBe(true);
  });

  it("lets the claude adapter emit turn_end without adding a synthetic one", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-338"));
    sandbox.streamScript = [
      { type: "stdout", data: '{"type":"assistant","message":{"content":[{"type":"text","text":"Done"}]}}\n' },
      { type: "stdout", data: '{"type":"result","subtype":"success"}\n' },
      { type: "complete", exitCode: 0 },
    ];
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
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    sandbox.streamScript = [
      { type: "stdout", data: '{"type":"agent_start"}\n' },
      { type: "stdout", data: '{"type":"agent_end"}\n' },
      { type: "complete", exitCode: 0 },
    ];
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

    expect(sandbox.destroyed).toBe(true);
  });

  it("redacts repo URL in clone thought when it contains a token", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-311"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    sandbox.streamScript = [
      { type: "stdout", data: '{"type":"agent_end"}\n' },
      { type: "complete", exitCode: 0 },
    ];
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
      (e) => e.type === "thought" && typeof e.text === "string" && e.text.includes("Cloning"),
    );
    expect(cloneThought).toBeDefined();
    expect((cloneThought as { text: string }).text).toContain("github.com/x/y.git");
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
    expect(events.map((e) => e.type)).toEqual(["thought", "error", "result"]);
    expect((events[0] as { text: string }).text).toContain("Spinning up");
    expect((events[1] as { message: string }).message).toContain(
      "missing_baseline",
    );
    expect((events[2] as { exit_code: number }).exit_code).not.toBe(0);
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
    expect(events.map((e) => e.type)).toEqual([
      "thought",
      "thought",
      "thought",
      "error",
      "result",
    ]);
    expect((events[3] as { message: string }).message).toContain("clone_failed");
    expect((events[4] as { exit_code: number }).exit_code).toBe(128);
    expect(sandbox.destroyed).toBe(true);
  });

  it("emits error and result when MCP config write fails", async () => {
    const app = buildApp();
    const db = new FakeD1();
    seedBaseline(db, "pi");

    const sandbox = new FakeSandbox(runSandboxId("SYM-312"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    sandbox.writeFileError = new Error("Permission denied");
    sandbox.streamScript = [];
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
    expect(events.map((e) => e.type)).toEqual([
      "thought",
      "thought",
      "thought",
      "error",
      "result",
    ]);
    expect((events[3] as { message: string }).message).toContain(
      "mcp_config_write_failed",
    );
    expect((events[4] as { exit_code: number }).exit_code).toBe(1);
    expect(sandbox.destroyed).toBe(true);
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
    sandbox.streamScript = [
      { type: "stdout", data: '{"type":"agent_start"}\n' },
      { type: "stdout", data: '{"type":"agent_end"}\n' },
      { type: "complete", exitCode: 0 },
    ];
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
    const resultEvent = events.find((e) => e.type === "result");
    expect((resultEvent as { branch: string }).branch).toBe("symphony/sym-510");
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
    sandbox.streamScript = [
      { type: "stdout", data: '{"type":"agent_start"}\n' },
      { type: "stdout", data: '{"type":"agent_end"}\n' },
      { type: "complete", exitCode: 0 },
    ];
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
