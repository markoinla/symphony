import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sandboxHandles: Record<string, FakeSandbox> = {};

vi.mock("@cloudflare/sandbox", () => {
  return {
    getSandbox: vi.fn((_ns: unknown, id: string) => {
      if (!sandboxHandles[id]) sandboxHandles[id] = new FakeSandbox(id);
      return sandboxHandles[id];
    }),
    proxyToSandbox: vi.fn(async () => null),
  };
});

import { buildApp, type Env } from "../src/index";
import { computeSignature } from "../src/hmac";
import {
  ENGINE_CMD_PATH,
  FORWARDER_PATH,
  FORWARDER_SCRIPT,
  INGEST_CONFIG_PATH,
} from "../src/forwarder";
import { parseIngestUrl, runProcessId, runSandboxId } from "../src/run";

const SECRET = "run-start-test-secret";

class FakeSandbox {
  constructor(public id: string) {}

  destroyed = false;
  restoredBackups: Array<{ id: string; dir: string }> = [];
  execCalls: string[] = [];
  execQueue: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
  mkdirCalls: string[] = [];
  writeFileCalls: Array<{ path: string; content: string }> = [];
  startProcessCalls: Array<{
    command: string;
    processId?: string;
    autoCleanup?: boolean;
    timeout?: number;
  }> = [];
  hasProcess = false;

  async restoreBackup(handle: { id: string; dir: string }) {
    this.restoredBackups.push({ id: handle.id, dir: handle.dir });
    return { success: true, dir: handle.dir, id: handle.id };
  }

  async exec(cmd: string, _opts?: { timeout?: number }) {
    this.execCalls.push(cmd);
    return this.execQueue.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }

  async mkdir(path: string) {
    this.mkdirCalls.push(path);
  }

  async writeFile(path: string, content: string) {
    this.writeFileCalls.push({ path, content });
  }

  async startProcess(
    command: string,
    options?: { processId?: string; autoCleanup?: boolean; timeout?: number },
  ) {
    this.startProcessCalls.push({
      command,
      processId: options?.processId,
      autoCleanup: options?.autoCleanup,
      timeout: options?.timeout,
    });
    this.hasProcess = true;
    return {
      id: options?.processId ?? "proc",
      command,
      status: "running",
      startTime: new Date(),
    };
  }

  async getProcess(id: string) {
    // Mirror the SDK: a missing process throws ProcessNotFoundError
    // (folded into a plain Error across the DO RPC boundary).
    if (!this.hasProcess) {
      throw new Error(`ProcessNotFoundError: Process ${id} not found`);
    }
    return {
      id,
      command: "",
      status: "running",
      exitCode: null,
      startTime: new Date(),
    };
  }

  async destroy() {
    this.destroyed = true;
  }
}

class FakeD1 {
  rows = new Map<string, { handle: string }>();
  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
  private bindings: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
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
    return (row ? ({ engine: key, ...row } as unknown as T) : null);
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

function seedBaseline(db: FakeD1, engine: string) {
  db.rows.set(engine, {
    handle: JSON.stringify({ id: `baseline-${engine}`, dir: "/home/symphony" }),
  });
}

async function signedRequest(body: string): Promise<Request> {
  const sig = await computeSignature(SECRET, body);
  return new Request("https://example/run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Symphony-Signature": sig },
    body,
  });
}

const BASE_BODY = {
  issue_id: "SYM-1",
  run_id: "sess-1",
  instance_id: "sess-1:r9",
  repo_url: "https://github.com/markoinla/symphony.git",
  prompt: "Add today's date to README.md.",
  engine: "pi",
  model: "anthropic/claude-sonnet-4-6",
  ingest_url: "https://linear-agent.example",
};

beforeEach(() => {
  for (const k of Object.keys(sandboxHandles)) delete sandboxHandles[k];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("parseIngestUrl", () => {
  it("accepts https URLs and rejects everything else", () => {
    expect(parseIngestUrl("https://linear-agent.example")).toBe(
      "https://linear-agent.example",
    );
    expect(parseIngestUrl(undefined)).toBeNull();
    expect(parseIngestUrl("http://insecure.example")).toBe(false);
    expect(parseIngestUrl("https://evil.example/$(whoami)")).toBe(false);
    expect(parseIngestUrl(42)).toBe(false);
  });
});

describe("POST /run/start", () => {
  it("restores, clones, writes the forwarder files, and launches it", async () => {
    const db = new FakeD1();
    seedBaseline(db, "pi");
    const sandbox = new FakeSandbox(runSandboxId("sess-1"));
    sandboxHandles[runSandboxId("sess-1")] = sandbox;

    const res = await buildApp().fetch(
      await signedRequest(JSON.stringify(BASE_BODY)),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, run_id: "sess-1" });

    // Setup: baseline restore + mkdir/rm/clone.
    expect(sandbox.restoredBackups).toEqual([
      { id: "baseline-pi", dir: "/home/symphony" },
    ]);
    expect(sandbox.execCalls).toHaveLength(3);
    expect(sandbox.execCalls[2]).toContain("git clone");

    // Three per-run files written into the sandbox.
    const byPath = new Map(
      sandbox.writeFileCalls.map((w) => [w.path, w.content]),
    );
    expect(byPath.get(FORWARDER_PATH)).toBe(FORWARDER_SCRIPT);
    expect(byPath.get(ENGINE_CMD_PATH)).toContain("pi --print --mode json");
    expect(byPath.get(ENGINE_CMD_PATH)).toContain("README.md");

    // Ingest config — full URL, per-run token, threaded instance id.
    const cfg = JSON.parse(byPath.get(INGEST_CONFIG_PATH)!) as {
      url: string;
      token: string;
      instanceId: string;
      timeoutMs: number;
    };
    expect(cfg.url).toBe(
      "https://linear-agent.example/internal/run-events/sess-1",
    );
    expect(cfg.token).toBe(await computeSignature(SECRET, "sess-1"));
    expect(cfg.instanceId).toBe("sess-1:r9");
    expect(cfg.timeoutMs).toBe(35 * 60 * 1000);

    // Forwarder launched as a detached process; sandbox NOT destroyed.
    expect(sandbox.startProcessCalls).toHaveLength(1);
    expect(sandbox.startProcessCalls[0]!.command).toContain(
      `node ${FORWARDER_PATH}`,
    );
    expect(sandbox.startProcessCalls[0]!.processId).toBe(
      runProcessId("sess-1", 1),
    );
    expect(sandbox.startProcessCalls[0]!.autoCleanup).toBe(false);
    expect(sandbox.startProcessCalls[0]!.timeout).toBe(36 * 60 * 1000);
    expect(sandbox.destroyed).toBe(false);
  });

  it("threads custom timeout_ms to the forwarder and adds process grace", async () => {
    const db = new FakeD1();
    seedBaseline(db, "pi");
    const sandbox = new FakeSandbox(runSandboxId("sess-1"));
    sandboxHandles[runSandboxId("sess-1")] = sandbox;

    const res = await buildApp().fetch(
      await signedRequest(JSON.stringify({ ...BASE_BODY, timeout_ms: 12_345 })),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const byPath = new Map(
      sandbox.writeFileCalls.map((w) => [w.path, w.content]),
    );
    const cfg = JSON.parse(byPath.get(INGEST_CONFIG_PATH)!) as {
      timeoutMs: number;
    };
    expect(cfg.timeoutMs).toBe(12_345);
    expect(sandbox.startProcessCalls[0]!.timeout).toBe(72_345);
  });

  it("is idempotent — a retry with the process already running skips setup", async () => {
    const db = new FakeD1();
    seedBaseline(db, "pi");
    const sandbox = new FakeSandbox(runSandboxId("sess-1"));
    sandbox.hasProcess = true; // forwarder from a prior attempt is live
    sandboxHandles[runSandboxId("sess-1")] = sandbox;

    const res = await buildApp().fetch(
      await signedRequest(JSON.stringify(BASE_BODY)),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      already_running: true,
    });
    expect(sandbox.restoredBackups).toHaveLength(0);
    expect(sandbox.execCalls).toHaveLength(0);
    expect(sandbox.startProcessCalls).toHaveLength(0);
  });

  it("returns 412 when no pi baseline exists", async () => {
    const db = new FakeD1();
    const res = await buildApp().fetch(
      await signedRequest(JSON.stringify(BASE_BODY)),
      makeEnv(db),
    );
    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({ error: "missing_baseline" });
  });

  it("returns 502 and launches nothing when the clone fails", async () => {
    const db = new FakeD1();
    seedBaseline(db, "pi");
    const sandbox = new FakeSandbox(runSandboxId("sess-1"));
    sandbox.execQueue = [
      { exitCode: 0, stdout: "", stderr: "" }, // mkdir
      { exitCode: 0, stdout: "", stderr: "" }, // rm + mkdir
      { exitCode: 128, stdout: "", stderr: "fatal: repository not found" },
    ];
    sandboxHandles[runSandboxId("sess-1")] = sandbox;

    const res = await buildApp().fetch(
      await signedRequest(JSON.stringify(BASE_BODY)),
      makeEnv(db),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "clone_failed" });
    expect(sandbox.startProcessCalls).toHaveLength(0);
  });

  it("400s when ingest_url is missing", async () => {
    const db = new FakeD1();
    seedBaseline(db, "pi");
    const { ingest_url: _omit, ...body } = BASE_BODY;
    const res = await buildApp().fetch(
      await signedRequest(JSON.stringify(body)),
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "missing_ingest_url" });
  });

  it("400s when instance_id is missing", async () => {
    const db = new FakeD1();
    seedBaseline(db, "pi");
    const { instance_id: _omit, ...body } = BASE_BODY;
    const res = await buildApp().fetch(
      await signedRequest(JSON.stringify(body)),
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "missing_instance_id" });
  });

  it("400s for non-pi engines — claude keeps the SSE path", async () => {
    const db = new FakeD1();
    seedBaseline(db, "claude");
    const res = await buildApp().fetch(
      await signedRequest(JSON.stringify({ ...BASE_BODY, engine: "claude" })),
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "engine_not_supported_for_start",
    });
  });

  it("401s an unsigned request", async () => {
    const db = new FakeD1();
    seedBaseline(db, "pi");
    const res = await buildApp().fetch(
      new Request("https://example/run/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(BASE_BODY),
      }),
      makeEnv(db),
    );
    expect(res.status).toBe(401);
  });
});
