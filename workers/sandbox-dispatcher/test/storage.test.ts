import { describe, expect, it } from "vitest";
import { BaselineStore } from "../src/storage";

class FakeD1 {
  rows = new Map<
    string,
    {
      handle: string;
      version: string | null;
      created_at: number;
      refreshed_at: number | null;
    }
  >();

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
  private bindings: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

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
      const existed = this.db.rows.delete(engine);
      return { success: true, meta: { changes: existed ? 1 : 0 } };
    }
    if (sql.startsWith("UPDATE engine_baselines")) {
      const [refreshed_at, engine] = this.bindings as [number, string];
      const row = this.db.rows.get(engine);
      if (row) this.db.rows.set(engine, { ...row, refreshed_at });
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    throw new Error(`Unsupported run SQL: ${sql}`);
  }

  async first<T>(): Promise<T | null> {
    const [engine] = this.bindings as [string];
    const row = this.db.rows.get(engine);
    return row ? ({ engine, ...row } as T) : null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return {
      results: [...this.db.rows.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([engine, row]) => ({ engine, ...row }) as T),
    };
  }
}

describe("BaselineStore", () => {
  it("upserts, reads summaries, lists, touches, and deletes baselines", async () => {
    const db = new FakeD1();
    const store = new BaselineStore(db as unknown as D1Database);

    await store.upsert("pi", { id: "backup-1", dir: "/home/symphony" }, "v1", 100);
    await store.upsert("claude", { id: "backup-2", dir: "/home/symphony" }, null, 101);

    await expect(store.getSummary("pi")).resolves.toEqual({
      engine: "pi",
      baseline_id: "backup-1",
      version: "v1",
      created_at: 100,
      refreshed_at: 100,
    });

    await store.touchRefreshed("pi", 200);
    expect((await store.get("pi"))?.refreshed_at).toBe(200);
    expect((await store.list()).map((r) => r.engine)).toEqual(["claude", "pi"]);

    await expect(store.delete("missing")).resolves.toBe(false);
    await expect(store.delete("pi")).resolves.toBe(true);
    await expect(store.get("pi")).resolves.toBeNull();
  });

  it("throws a useful error for malformed stored backup handles", async () => {
    const db = new FakeD1();
    db.rows.set("pi", {
      handle: JSON.stringify({ id: "backup-without-dir" }),
      version: null,
      created_at: 100,
      refreshed_at: null,
    });

    const store = new BaselineStore(db as unknown as D1Database);
    await expect(store.get("pi")).rejects.toThrow(
      /handle is not a valid DirectoryBackup/,
    );
  });
});
