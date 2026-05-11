import { describe, expect, it } from "vitest";
import { InstallationStore, ProjectStore } from "../src/lib/store";
import { FakeD1 } from "./helpers/fake-d1";

describe("InstallationStore", () => {
  it("upserts and reads a row by organization_id", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert("org-1", "token-abc", "read,write,app:assignable");

    const row = await store.get("org-1");
    expect(row?.organization_id).toBe("org-1");
    expect(row?.access_token).toBe("token-abc");
    expect(row?.scopes).toBe("read,write,app:assignable");
  });

  it("overwrites an existing row on conflict", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert("org-1", "old-token", "read");
    await store.upsert("org-1", "new-token", "read,write");

    const row = await store.get("org-1");
    expect(row?.access_token).toBe("new-token");
    expect(row?.scopes).toBe("read,write");
  });

  it("returns the only install when exactly one exists", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert("org-only", "tok", "read");
    const single = await store.getOnlyInstallation();
    expect(single?.organization_id).toBe("org-only");
  });

  it("returns null when multiple installs exist (ambiguous)", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert("org-a", "tok-a", "read");
    await store.upsert("org-b", "tok-b", "read");
    expect(await store.getOnlyInstallation()).toBeNull();
  });

  it("delete returns true only when a row was removed", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert("org-1", "tok", "read");
    expect(await store.delete("org-1")).toBe(true);
    expect(await store.delete("org-1")).toBe(false);
  });
});

describe("ProjectStore", () => {
  it("upserts and reads a project by team_id with defaults", async () => {
    const db = new FakeD1();
    const store = new ProjectStore(db as unknown as D1Database);

    await store.upsert({
      teamId: "team-abc",
      repoUrl: "https://github.com/x/y.git",
    });

    const row = await store.get("team-abc");
    expect(row).toMatchObject({
      team_id: "team-abc",
      repo_url: "https://github.com/x/y.git",
      default_branch: "main",
      engine: "pi",
      model: null,
      max_turns: 10,
    });
  });

  it("respects explicit engine/model/max_turns values", async () => {
    const db = new FakeD1();
    const store = new ProjectStore(db as unknown as D1Database);

    await store.upsert({
      teamId: "team-claude",
      repoUrl: "https://github.com/x/y.git",
      engine: "claude",
      model: "claude-sonnet-4-6",
      maxTurns: 25,
      defaultBranch: "trunk",
    });

    const row = await store.get("team-claude");
    expect(row).toMatchObject({
      engine: "claude",
      model: "claude-sonnet-4-6",
      max_turns: 25,
      default_branch: "trunk",
    });
  });
});
