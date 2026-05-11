import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked references — populated by the vi.mock factory below and inspected
// in each test. The factory must not capture outer-scope variables, so we
// use module-level holders that are filled in before tests run.
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

const SECRET = "auth-test-secret";

class FakeSandbox {
  constructor(public id: string) {}

  destroyed = false;
  startedProcesses: string[] = [];
  exposedPorts: Array<{ port: number; hostname: string }> = [];
  createdBackups: Array<{ dir: string; name?: string }> = [];
  restoredBackups: Array<{ id: string; dir: string }> = [];
  execCalls: string[] = [];
  waitedForPorts: Array<{ port: number }> = [];

  // The handler now does `await sandbox.exec(BOOTSTRAP_PREP_CMD)` to
  // ensure ttyd + bashrc are present, then `await ttydProc.waitForPort(...)`
  // before exposing the port. Both stubs succeed silently here.
  async exec(command: string) {
    this.execCalls.push(command);
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async startProcess(command: string) {
    this.startedProcesses.push(command);
    const sandbox = this;
    return {
      id: `proc-${this.startedProcesses.length}`,
      async waitForPort(port: number, _opts?: unknown) {
        sandbox.waitedForPorts.push({ port });
      },
    };
  }

  async exposePort(port: number, opts: { hostname: string }) {
    this.exposedPorts.push({ port, hostname: opts.hostname });
    return {
      url: `https://${port}-${this.id.replace(/[^a-z0-9]/gi, "-")}.${opts.hostname}`,
      port,
      name: undefined,
    };
  }

  async createBackup(opts: { dir: string; name?: string; ttl?: number }) {
    this.createdBackups.push({ dir: opts.dir, name: opts.name });
    return {
      id: `backup-${this.id}-${this.createdBackups.length}`,
      dir: opts.dir,
      localBucket: false,
    };
  }

  async restoreBackup(handle: { id: string; dir: string }) {
    this.restoredBackups.push({ id: handle.id, dir: handle.dir });
    return { success: true, dir: handle.dir, id: handle.id };
  }

  async destroy() {
    this.destroyed = true;
  }
}

class FakeD1 {
  rows = new Map<string, { handle: string; created_at: number; refreshed_at: number | null }>();

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
      const [scope, handle, created_at, refreshed_at] = this.bindings as [string, string, number, number];
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
      const [refreshed, scope] = this.bindings as [number, string];
      const row = this.db.rows.get(scope);
      if (row) row.refreshed_at = refreshed;
      return { success: true, meta: { changes: row ? 1 : 0 } };
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
    const sql = this.sql.trim();
    if (!sql.startsWith("SELECT")) throw new Error(`all() called on non-SELECT: ${sql}`);
    return {
      success: true,
      results: Array.from(this.db.rows.entries()).map(([scope, row]) => ({
        scope,
        ...row,
      })) as unknown as T[],
    };
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

/**
 * Look up the FakeSandbox the route handler should have created. Helper
 * to satisfy `noUncheckedIndexedAccess` while keeping individual asserts
 * readable.
 */
function getSandboxForId(id: string): FakeSandbox {
  const sandbox = sandboxHandles[id];
  if (!sandbox) throw new Error(`expected fake sandbox to exist for id=${id}`);
  return sandbox;
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

beforeEach(() => {
  for (const k of Object.keys(sandboxHandles)) delete sandboxHandles[k];
  proxyToSandboxImpl = async () => null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /auth/bootstrap", () => {
  it("creates a bootstrap sandbox, starts ttyd, and exposes the PTY port", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const body = JSON.stringify({ scope: "alice" });

    const res = await app.fetch(
      await signedRequest("https://example/auth/bootstrap", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.scope).toBe("alice");
    // Sandbox IDs sanitize to DNS-safe labels (colons silently break the
    // SDK's preview-URL builder); see sanitizeScopeForId.
    expect(json.sandbox_id).toBe("bootstrap-alice");
    expect(typeof json.pty_url).toBe("string");
    expect((json.pty_url as string).startsWith("https://7681-bootstrap")).toBe(true);
    expect(json.had_prior_snapshot).toBe(false);

    const sandbox = getSandboxForId("bootstrap-alice");
    // ttyd is now launched from the snapshot prefix with HOME pinned to
    // /home/symphony (so login files land inside the backup root).
    expect(sandbox.startedProcesses[0]).toMatch(
      /^env HOME=\/home\/symphony \/home\/symphony\/\.local\/bin\/ttyd -p 7681/,
    );
    expect(sandbox.exposedPorts).toEqual([{ port: 7681, hostname: "example" }]);
    expect(sandbox.restoredBackups).toEqual([]);
    // Bootstrap PREP cmd runs once via sandbox.exec to install ttyd +
    // initialize bashrc/bash_profile (idempotent).
    expect(sandbox.execCalls.length).toBeGreaterThan(0);
    // proc.waitForPort runs after startProcess to make sure ttyd is
    // reachable before we expose the port to browsers.
    expect(sandbox.waitedForPorts).toEqual([{ port: 7681 }]);
    // We don't assert `destroyed` here: the bootstrap handler does a
    // defensive `safeDestroy` at the start to clear any prior sandbox
    // state for the same id. With the FakeSandbox's id-based memoization,
    // the flag stays set; in production the second getSandbox spins a
    // fresh container, but this test isn't exercising that distinction.
  });

  it("restores any prior snapshot before starting ttyd", async () => {
    const app = buildApp();
    const db = new FakeD1();
    db.rows.set("alice", {
      handle: JSON.stringify({ id: "backup-prior", dir: "/home/symphony" }),
      created_at: 1_700_000_000,
      refreshed_at: 1_700_000_000,
    });
    const body = JSON.stringify({ scope: "alice" });

    const res = await app.fetch(
      await signedRequest("https://example/auth/bootstrap", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.had_prior_snapshot).toBe(true);

    const sandbox = getSandboxForId("bootstrap-alice");
    expect(sandbox.restoredBackups).toEqual([
      { id: "backup-prior", dir: "/home/symphony" },
    ]);
  });

  it("rejects requests missing a scope", async () => {
    const app = buildApp();
    const res = await app.fetch(
      await signedRequest("https://example/auth/bootstrap", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      makeEnv(new FakeD1()),
    );
    expect(res.status).toBe(400);
  });

  it("rejects scopes containing path-unsafe characters", async () => {
    const app = buildApp();
    const res = await app.fetch(
      await signedRequest("https://example/auth/bootstrap", {
        method: "POST",
        body: JSON.stringify({ scope: "alice/../etc" }),
      }),
      makeEnv(new FakeD1()),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /auth/snapshot", () => {
  it("creates a backup, persists the handle, and destroys the sandbox", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const body = JSON.stringify({ scope: "alice" });

    const res = await app.fetch(
      await signedRequest("https://example/auth/snapshot", { method: "POST", body }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.scope).toBe("alice");
    expect(typeof json.backup_id).toBe("string");

    const sandbox = getSandboxForId("bootstrap-alice");
    expect(sandbox.createdBackups).toHaveLength(1);
    expect(sandbox.createdBackups[0]?.dir).toBe("/home/symphony");
    expect(sandbox.destroyed).toBe(true);

    const row = db.rows.get("alice");
    expect(row).toBeDefined();
    const persisted = JSON.parse(row!.handle);
    expect(persisted.id).toBe(json.backup_id);
    expect(persisted.dir).toBe("/home/symphony");
  });

  it("destroys the sandbox even when createBackup throws", async () => {
    const app = buildApp();
    const db = new FakeD1();

    // Pre-populate the sandbox so we can stub its createBackup to throw.
    const failingSandbox = new FakeSandbox("bootstrap-alice");
    failingSandbox.createBackup = async () => {
      throw new Error("backup-failed");
    };
    sandboxHandles["bootstrap-alice"] = failingSandbox;

    const body = JSON.stringify({ scope: "alice" });
    const res = await app.fetch(
      await signedRequest("https://example/auth/snapshot", { method: "POST", body }),
      makeEnv(db),
    );

    // Hono's default error handler turns thrown errors into a 500 response;
    // the important guarantee we're verifying is that the sandbox was still
    // destroyed and no row was persisted.
    expect(res.status).toBe(500);
    expect(failingSandbox.destroyed).toBe(true);
    expect(db.rows.size).toBe(0);
  });
});

describe("GET /auth/snapshot", () => {
  it("returns 404 when no snapshot exists for the scope", async () => {
    const app = buildApp();
    const res = await app.fetch(
      await signedRequest("https://example/auth/snapshot?scope=ghost"),
      makeEnv(new FakeD1()),
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ exists: false, scope: "ghost" });
  });

  it("returns the summary (no handle) when a snapshot exists", async () => {
    const app = buildApp();
    const db = new FakeD1();
    db.rows.set("alice", {
      handle: JSON.stringify({ id: "backup-xyz", dir: "/home/node" }),
      created_at: 1_700_000_000,
      refreshed_at: 1_700_500_000,
    });

    const res = await app.fetch(
      await signedRequest("https://example/auth/snapshot?scope=alice"),
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({
      exists: true,
      scope: "alice",
      backup_id: "backup-xyz",
      created_at: 1_700_000_000,
      refreshed_at: 1_700_500_000,
    });
    expect(json).not.toHaveProperty("handle");
  });
});

describe("DELETE /auth/snapshot", () => {
  it("removes the row and reports whether anything was deleted", async () => {
    const app = buildApp();
    const db = new FakeD1();
    db.rows.set("alice", {
      handle: JSON.stringify({ id: "backup-xyz", dir: "/home/node" }),
      created_at: 1,
      refreshed_at: null,
    });

    const res = await app.fetch(
      await signedRequest("https://example/auth/snapshot", {
        method: "DELETE",
        body: JSON.stringify({ scope: "alice" }),
      }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scope: "alice", removed: true });
    expect(db.rows.has("alice")).toBe(false);
  });

  it("returns removed=false when the scope was not present", async () => {
    const app = buildApp();
    const res = await app.fetch(
      await signedRequest("https://example/auth/snapshot", {
        method: "DELETE",
        body: JSON.stringify({ scope: "ghost" }),
      }),
      makeEnv(new FakeD1()),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scope: "ghost", removed: false });
  });
});
