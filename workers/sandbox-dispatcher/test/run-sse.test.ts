import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Streaming branch tests for POST /run with `Accept: text/event-stream`.
 *
 * Strategy: stub `@cloudflare/sandbox` so `execStream` returns a
 * synthetic SSE stream of `ExecEvent`s (matching what the real sandbox
 * emits when running pi `--mode json`). Assert that the dispatcher
 * line-buffers stdout chunks, runs them through the pi adapter, and
 * emits normalized events terminated by exactly one `result` frame.
 */

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

  /**
   * Returns a ReadableStream<Uint8Array> shaped like the real sandbox's
   * execStream output: SSE frames with `data: <ExecEvent JSON>\n\n`
   * separators. The encoded events come from `this.streamScript`.
   */
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

/**
 * Minimal SSE parser used by the test mock. Reads `data: ...` lines
 * separated by blank lines and yields the parsed JSON objects. The
 * production code uses `@cloudflare/sandbox`'s own helper; we
 * replicate its semantics inside the test mock so we don't depend on
 * unknown internals.
 */
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
    return { success: true, meta: { changes: 0 } };
  }
  async first<T>() {
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
  headers.set("Accept", "text/event-stream");
  if (body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(url, { ...init, headers });
}

function seedBackup(db: FakeD1, scope: string) {
  db.rows.set(scope, {
    handle: JSON.stringify({ id: `backup-${scope}`, dir: "/root" }),
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
    seedBackup(db, "alice");

    const sandbox = new FakeSandbox(runSandboxId("SYM-200"));
    sandbox.streamScript = [
      // Lifecycle events pi emits but the adapter drops:
      { type: "stdout", data: '{"type":"session","id":"x"}\n' },
      { type: "stdout", data: '{"type":"agent_start"}\n' },
      // Assistant message split across two stdout chunks to verify
      // the line buffer reassembles partial lines.
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
      scope: "alice",
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
      "assistant_msg",
      "turn_end",
      "result",
    ]);
    expect(events[0]).toMatchObject({
      type: "assistant_msg",
      text: "Done — opened PR #123.",
    });
    expect(events[1]).toMatchObject({ type: "turn_end", turn: 1, reason: "completed" });
    expect(events[2]).toMatchObject({ type: "result", exit_code: 0 });
    expect(events[2]?.duration_ms).toEqual(expect.any(Number));
    expect(sandbox.destroyed).toBe(true);
  });

  it("emits an error event then result when the snapshot is missing", async () => {
    const app = buildApp();
    const db = new FakeD1();
    // No seedBackup — scope is unknown.

    const body = JSON.stringify({
      scope: "ghost",
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
    expect(events.map((e) => e.type)).toEqual(["error", "result"]);
    expect((events[0] as { message: string }).message).toContain(
      "missing_auth_backup",
    );
    expect((events[1] as { exit_code: number }).exit_code).not.toBe(0);
  });

  it("emits an error event then result when git clone fails", async () => {
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
    expect((events[0] as { message: string }).message).toContain("clone_failed");
    expect((events[1] as { exit_code: number }).exit_code).toBe(128);
    expect(sandbox.destroyed).toBe(true);
  });
});
