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
import {
  DEFAULT_REFRESH_AGE_SECONDS,
  refreshSandboxId,
  refreshStaleSnapshots,
} from "../src/refresh";

const SECRET = "refresh-test-secret";

class FakeSandbox {
  constructor(public id: string) {}

  destroyed = false;
  restoredBackups: Array<{ id: string; dir: string }> = [];
  createdBackups: Array<{ dir: string; name?: string }> = [];

  // Tests can override these to simulate failures.
  restoreBackupImpl: (handle: { id: string; dir: string }) => Promise<void> =
    async () => {};
  createBackupImpl: (opts: {
    dir: string;
    name?: string;
    ttl?: number;
  }) => Promise<{ id: string; dir: string }> = async (opts) => ({
    id: `backup-${this.id}-${this.createdBackups.length + 1}`,
    dir: opts.dir,
  });

  async restoreBackup(handle: { id: string; dir: string }) {
    await this.restoreBackupImpl(handle);
    this.restoredBackups.push({ id: handle.id, dir: handle.dir });
    return { success: true, dir: handle.dir, id: handle.id };
  }

  async createBackup(opts: { dir: string; name?: string; ttl?: number }) {
    const result = await this.createBackupImpl(opts);
    this.createdBackups.push({ dir: opts.dir, name: opts.name });
    return { ...result, localBucket: false };
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
    if (sql.startsWith("UPDATE auth_backups")) {
      const [refreshedAt, scope] = this.bindings as [number, string];
      const row = this.db.rows.get(scope);
      if (row) {
        this.db.rows.set(scope, { ...row, refreshed_at: refreshedAt });
      }
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (sql.startsWith("DELETE FROM auth_backups")) {
      const [scope] = this.bindings as [string];
      const had = this.db.rows.has(scope);
      this.db.rows.delete(scope);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }
    throw new Error(`Unsupported SQL.run in fake D1: ${sql}`);
  }

  async first<T>(): Promise<T | null> {
    const sql = this.sql.trim();
    if (!sql.startsWith("SELECT")) {
      throw new Error(`first() called on non-SELECT: ${sql}`);
    }
    const [scope] = this.bindings as [string];
    const row = this.db.rows.get(scope);
    if (!row) return null;
    return { scope, ...row } as unknown as T;
  }

  async all<T>(): Promise<{ success: true; results: T[] }> {
    const sql = this.sql.trim();
    if (!sql.startsWith("SELECT")) {
      throw new Error(`all() called on non-SELECT: ${sql}`);
    }
    const results = Array.from(this.db.rows.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([scope, row]) => ({ scope, ...row }) as unknown as T);
    return { success: true, results };
  }
}

function makeEnv(db: FakeD1): Env {
  return {
    DISPATCH_HMAC_SECRET: SECRET,
    Sandbox: {} as Env["Sandbox"],
    BACKUP_BUCKET: {} as R2Bucket,
    DB: db as unknown as D1Database,
  };
}

function seedRow(
  db: FakeD1,
  scope: string,
  refreshedAt: number,
  backupId: string,
): void {
  db.rows.set(scope, {
    handle: JSON.stringify({ id: backupId, dir: "/home/symphony" }),
    created_at: refreshedAt,
    refreshed_at: refreshedAt,
  });
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
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("refreshSandboxId", () => {
  it("sanitizes scope chars to keep DNS labels valid", () => {
    expect(refreshSandboxId("alice")).toBe("refresh-alice");
    expect(refreshSandboxId("alice:proj-42")).toBe("refresh-alice-proj-42");
    expect(refreshSandboxId("Alice@Co")).toBe("refresh-alice-co");
  });
});

describe("refreshStaleSnapshots", () => {
  const now = 1_700_000_000;

  it("skips rows whose refreshed_at is younger than the threshold", async () => {
    const db = new FakeD1();
    seedRow(db, "alice", now - 60, "backup-young");

    const results = await refreshStaleSnapshots(makeEnv(db), now);

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe("skipped");
    expect(results[0]?.scope).toBe("alice");
    expect(results[0]?.new_backup_id).toBeUndefined();
    // No sandbox spun up for skipped rows.
    expect(sandboxHandles[refreshSandboxId("alice")]).toBeUndefined();
    // D1 row untouched.
    expect(db.rows.get("alice")?.refreshed_at).toBe(now - 60);
  });

  it("refreshes rows older than the threshold via restore + recreate", async () => {
    const db = new FakeD1();
    const old = now - DEFAULT_REFRESH_AGE_SECONDS - 86_400;
    seedRow(db, "alice", old, "backup-old");

    const results = await refreshStaleSnapshots(makeEnv(db), now);

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.outcome).toBe("refreshed");
    expect(result.scope).toBe("alice");
    expect(result.old_backup_id).toBe("backup-old");
    expect(result.new_backup_id).toMatch(/^backup-refresh-alice-/);
    expect(result.age_seconds_at_refresh).toBeGreaterThan(
      DEFAULT_REFRESH_AGE_SECONDS,
    );

    const sandbox = sandboxHandles[refreshSandboxId("alice")]!;
    // Restore the existing handle, then immediately recreate against the
    // snapshot dir so R2 gets a fresh object with today's timestamp.
    expect(sandbox.restoredBackups).toEqual([
      { id: "backup-old", dir: "/home/symphony" },
    ]);
    expect(sandbox.createdBackups).toHaveLength(1);
    expect(sandbox.createdBackups[0]?.dir).toBe("/home/symphony");
    expect(sandbox.destroyed).toBe(true);

    // D1 row carries the new handle and refreshed_at.
    const row = db.rows.get("alice")!;
    expect(row.refreshed_at).toBe(now);
    expect(JSON.parse(row.handle).id).toBe(result.new_backup_id);
  });

  it("force=true ignores the age threshold and refreshes everything", async () => {
    const db = new FakeD1();
    seedRow(db, "alice", now - 60, "backup-young");

    const results = await refreshStaleSnapshots(makeEnv(db), now, {
      force: true,
    });

    expect(results[0]?.outcome).toBe("refreshed");
    expect(db.rows.get("alice")?.refreshed_at).toBe(now);
  });

  it("isolates per-scope failures so other scopes still refresh", async () => {
    const db = new FakeD1();
    const old = now - DEFAULT_REFRESH_AGE_SECONDS - 1;
    seedRow(db, "alice", old, "backup-alice");
    seedRow(db, "bob", old, "backup-bob");

    // Pre-create alice's sandbox with a failing restoreBackup.
    const failing = new FakeSandbox(refreshSandboxId("alice"));
    failing.restoreBackupImpl = async () => {
      throw new Error("restore-blew-up");
    };
    sandboxHandles[refreshSandboxId("alice")] = failing;

    const results = await refreshStaleSnapshots(makeEnv(db), now);

    const alice = results.find((r) => r.scope === "alice")!;
    const bob = results.find((r) => r.scope === "bob")!;

    expect(alice.outcome).toBe("failed");
    expect(alice.error_message).toBe("restore-blew-up");
    // alice's D1 row is unchanged on failure.
    expect(db.rows.get("alice")?.refreshed_at).toBe(old);

    expect(bob.outcome).toBe("refreshed");
    expect(db.rows.get("bob")?.refreshed_at).toBe(now);
  });

  it("returns an empty array when there are no rows", async () => {
    const db = new FakeD1();
    const results = await refreshStaleSnapshots(makeEnv(db), now);
    expect(results).toEqual([]);
  });
});

describe("POST /auth/refresh", () => {
  // The HTTP handler reads `Math.floor(Date.now() / 1000)` for "now". Pin
  // it so the test's seed timestamps stay relative to a known epoch.
  const now = 1_700_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns aggregate counts and per-scope outcomes", async () => {
    const db = new FakeD1();
    seedRow(db, "alice", now - DEFAULT_REFRESH_AGE_SECONDS - 1, "backup-old");
    seedRow(db, "bob", now - 60, "backup-young");

    const app = buildApp();
    const res = await app.fetch(
      await signedRequest("https://example/auth/refresh", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.checked).toBe(2);
    expect(json.refreshed).toBe(1);
    expect(json.skipped).toBe(1);
    expect(json.failed).toBe(0);
  });

  it("force=true via body refreshes every scope regardless of age", async () => {
    const db = new FakeD1();
    seedRow(db, "alice", now - 60, "backup-young");
    seedRow(db, "bob", now - 60, "backup-bob-young");

    const app = buildApp();
    const res = await app.fetch(
      await signedRequest("https://example/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ force: true }),
      }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { refreshed: number; skipped: number };
    expect(json.refreshed).toBe(2);
    expect(json.skipped).toBe(0);
  });

  it("scope filter operates on a single row", async () => {
    const db = new FakeD1();
    seedRow(db, "alice", now - DEFAULT_REFRESH_AGE_SECONDS - 1, "backup-old");
    seedRow(db, "bob", now - DEFAULT_REFRESH_AGE_SECONDS - 1, "backup-old-bob");

    const app = buildApp();
    const res = await app.fetch(
      await signedRequest("https://example/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ scope: "alice" }),
      }),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      results: Array<{ scope: string; outcome: string }>;
    };
    expect(json.results).toHaveLength(1);
    expect(json.results[0]?.scope).toBe("alice");
    expect(json.results[0]?.outcome).toBe("refreshed");
    // bob untouched.
    expect(db.rows.get("bob")?.refreshed_at).toBe(
      now - DEFAULT_REFRESH_AGE_SECONDS - 1,
    );
  });

  it("returns 412 when scope filter targets a missing row", async () => {
    const db = new FakeD1();
    const app = buildApp();
    const res = await app.fetch(
      await signedRequest("https://example/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ scope: "ghost" }),
      }),
      makeEnv(db),
    );
    expect(res.status).toBe(412);
  });

  it("requires a valid HMAC", async () => {
    const db = new FakeD1();
    seedRow(db, "alice", now - 60, "backup");
    const app = buildApp();
    const res = await app.fetch(
      new Request("https://example/auth/refresh", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      }),
      makeEnv(db),
    );
    expect(res.status).toBe(401);
  });
});
