import { describe, expect, it } from "vitest";
import { InstallationStore, ProjectStore } from "../src/lib/store";
import { FakeD1 } from "./helpers/fake-d1";

describe("InstallationStore", () => {
  it("upserts and reads a row by org_id", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert("org-1", "token-abc", "read,write,app:assignable", "oauth");

    const row = await store.get("org-1");
    expect(row?.org_id).toBe("org-1");
    expect(row?.access_token).toBe("token-abc");
    expect(row?.scopes).toBe("read,write,app:assignable");
  });

  it("overwrites an existing row on conflict", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert("org-1", "old-token", "read", "oauth");
    await store.upsert("org-1", "new-token", "read,write", "oauth");

    const row = await store.get("org-1");
    expect(row?.access_token).toBe("new-token");
    expect(row?.scopes).toBe("read,write");
  });

  it("returns the only install when exactly one exists", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert("org-only", "tok", "read", "oauth");
    const single = await store.getOnlyInstallation();
    expect(single?.org_id).toBe("org-only");
  });

  it("returns null when multiple installs exist (ambiguous)", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert("org-a", "tok-a", "read", "oauth");
    await store.upsert("org-b", "tok-b", "read", "oauth");
    expect(await store.getOnlyInstallation()).toBeNull();
  });

  it("delete returns true only when a row was removed", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert("org-1", "tok", "read", "oauth");
    expect(await store.delete("org-1")).toBe(true);
    expect(await store.delete("org-1")).toBe(false);
  });
});

describe("ProjectStore", () => {
  it("upserts and reads a project by linear_team_id with defaults", async () => {
    const db = new FakeD1();
    const store = new ProjectStore(db as unknown as D1Database);

    await store.upsert({
      orgId: "org-1",
      linearTeamId: "team-abc",
      repoUrl: "https://github.com/x/y.git",
    });

    const row = await store.get("team-abc");
    expect(row).toMatchObject({
      org_id: "org-1",
      linear_team_id: "team-abc",
      repo_url: "https://github.com/x/y.git",
      default_branch: "main",
      engine: "pi",
      model: null,
      max_turns: 10,
      scope: null,
      system_prompt_override: null,
    });
  });

  it("respects explicit engine/model/max_turns/scope values", async () => {
    const db = new FakeD1();
    const store = new ProjectStore(db as unknown as D1Database);

    await store.upsert({
      orgId: "org-1",
      linearTeamId: "team-claude",
      repoUrl: "https://github.com/x/y.git",
      engine: "claude",
      model: "claude-sonnet-4-6",
      maxTurns: 25,
      defaultBranch: "trunk",
      scope: "enterprise",
      systemPromptOverride: "Be concise.",
    });

    const row = await store.get("team-claude");
    expect(row).toMatchObject({
      engine: "claude",
      model: "claude-sonnet-4-6",
      max_turns: 25,
      default_branch: "trunk",
      scope: "enterprise",
      system_prompt_override: "Be concise.",
    });
  });

  it("getByTeamId resolves with composite key", async () => {
    const db = new FakeD1();
    const store = new ProjectStore(db as unknown as D1Database);

    await store.upsert({
      orgId: "org-1",
      linearTeamId: "team-abc",
      repoUrl: "https://github.com/x/y.git",
    });

    const row = await store.getByTeamId("org-1", "team-abc");
    expect(row?.linear_team_id).toBe("team-abc");
    expect(await store.getByTeamId("org-2", "team-abc")).toBeNull();
  });

  it("delete requires both org_id and linear_team_id", async () => {
    const db = new FakeD1();
    const store = new ProjectStore(db as unknown as D1Database);

    await store.upsert({
      orgId: "org-1",
      linearTeamId: "team-abc",
      repoUrl: "https://github.com/x/y.git",
    });

    expect(await store.delete("org-1", "team-abc")).toBe(true);
    expect(await store.delete("org-1", "team-abc")).toBe(false);
  });
});
