import { describe, expect, it } from "vitest";
import { InstallationStore, ProjectStore, SessionStore, UserStore } from "../src/lib/store";
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

describe("UserStore", () => {
  it("upserts and reads a user by linear_user_id", async () => {
    const db = new FakeD1();
    const store = new UserStore(db as unknown as D1Database);

    await store.upsert({
      linearUserId: "user-1",
      organizationId: "org-1",
      accessToken: "tok-abc",
      email: "alice@example.com",
      name: "Alice",
    });

    const row = await store.getByLinearUserId("user-1");
    expect(row?.linear_user_id).toBe("user-1");
    expect(row?.organization_id).toBe("org-1");
    expect(row?.access_token).toBe("tok-abc");
    expect(row?.email).toBe("alice@example.com");
    expect(row?.name).toBe("Alice");
    expect(row?.refresh_token).toBeNull();
    expect(row?.expires_at).toBeNull();
  });

  it("overwrites token on re-auth", async () => {
    const db = new FakeD1();
    const store = new UserStore(db as unknown as D1Database);

    await store.upsert({
      linearUserId: "user-1",
      organizationId: "org-1",
      accessToken: "old-tok",
    });
    await store.upsert({
      linearUserId: "user-1",
      organizationId: "org-1",
      accessToken: "new-tok",
      refreshToken: "refresh-1",
      expiresAt: "2026-06-01T00:00:00Z",
    });

    const row = await store.getByLinearUserId("user-1");
    expect(row?.access_token).toBe("new-tok");
    expect(row?.refresh_token).toBe("refresh-1");
    expect(row?.expires_at).toBe("2026-06-01T00:00:00Z");
  });

  it("returns null for unknown user", async () => {
    const db = new FakeD1();
    const store = new UserStore(db as unknown as D1Database);
    expect(await store.getByLinearUserId("nope")).toBeNull();
  });

  it("lists users scoped by organization_id", async () => {
    const db = new FakeD1();
    const store = new UserStore(db as unknown as D1Database);

    await store.upsert({
      linearUserId: "u-a",
      organizationId: "org-1",
      accessToken: "t1",
    });
    await store.upsert({
      linearUserId: "u-b",
      organizationId: "org-1",
      accessToken: "t2",
    });
    await store.upsert({
      linearUserId: "u-c",
      organizationId: "org-2",
      accessToken: "t3",
    });

    const org1Users = await store.listByOrg("org-1");
    expect(org1Users).toHaveLength(2);
    expect(org1Users.map((u) => u.linear_user_id).sort()).toEqual(["u-a", "u-b"]);

    const org2Users = await store.listByOrg("org-2");
    expect(org2Users).toHaveLength(1);
    expect(org2Users[0]?.linear_user_id).toBe("u-c");
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

describe("SessionStore", () => {
  function seedUser(db: FakeD1, id = "user-1") {
    const users = new UserStore(db as unknown as D1Database);
    return users.upsert({
      linearUserId: id,
      organizationId: "org-1",
      accessToken: "tok",
      email: "alice@example.com",
      name: "Alice",
    });
  }

  it("creates a session and validates it", async () => {
    const db = new FakeD1();
    await seedUser(db);
    const store = new SessionStore(db as unknown as D1Database);

    const token = await store.create("user-1");
    expect(token).toHaveLength(64);

    const user = await store.validate(token);
    expect(user).not.toBeNull();
    expect(user?.linear_user_id).toBe("user-1");
    expect(user?.email).toBe("alice@example.com");
  });

  it("returns null for unknown token", async () => {
    const db = new FakeD1();
    const store = new SessionStore(db as unknown as D1Database);
    expect(await store.validate("bogus")).toBeNull();
  });

  it("returns null for expired session", async () => {
    const db = new FakeD1();
    await seedUser(db);
    const store = new SessionStore(db as unknown as D1Database);

    const token = await store.create("user-1", 0);
    // FakeD1 checks expiry; ttlDays=0 means expires_at is ~now
    const user = await store.validate(token);
    expect(user).toBeNull();
  });

  it("deletes a session by token", async () => {
    const db = new FakeD1();
    await seedUser(db);
    const store = new SessionStore(db as unknown as D1Database);

    const token = await store.create("user-1");
    expect(await store.delete(token)).toBe(true);
    expect(await store.validate(token)).toBeNull();
    expect(await store.delete(token)).toBe(false);
  });

  it("deletes all sessions for a user", async () => {
    const db = new FakeD1();
    await seedUser(db);
    const store = new SessionStore(db as unknown as D1Database);

    const t1 = await store.create("user-1");
    const t2 = await store.create("user-1");
    await store.deleteByUser("user-1");
    expect(await store.validate(t1)).toBeNull();
    expect(await store.validate(t2)).toBeNull();
  });
});
