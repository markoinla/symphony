import { describe, expect, it } from "vitest";
import { InstallationStore, OrgCredentialStore, ProjectStore, UserStore } from "../src/lib/store";
import { FakeD1 } from "./helpers/fake-d1";

describe("InstallationStore", () => {
  it("upserts and reads a row by organization_id", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      accessToken: "token-abc",
      scopes: "read,write,app:assignable",
    });

    const row = await store.get("org-1");
    expect(row?.organization_id).toBe("org-1");
    expect(row?.access_token).toBe("token-abc");
    expect(row?.scopes).toBe("read,write,app:assignable");
    expect(row?.status).toBe("active");
  });

  it("overwrites an existing row on conflict and preserves refresh metadata when omitted", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      accessToken: "old-token",
      scopes: "read",
      refreshToken: "rt-1",
      installedByLinearUserId: "user-1",
    });
    await store.upsert({
      organizationId: "org-1",
      accessToken: "new-token",
      scopes: "read,write",
    });

    const row = await store.get("org-1");
    expect(row?.access_token).toBe("new-token");
    expect(row?.scopes).toBe("read,write");
    expect(row?.refresh_token).toBe("rt-1");
    expect(row?.installed_by_linear_user_id).toBe("user-1");
  });

  it("records the GitHub App installation id without losing other fields", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      accessToken: "tok",
      scopes: "read",
    });
    await store.setGithubAppInstallationId("org-1", 12345);

    const row = await store.get("org-1");
    expect(row?.github_app_installation_id).toBe(12345);
    expect(row?.access_token).toBe("tok");
  });

  it("returns the only install when exactly one exists", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-only",
      accessToken: "tok",
      scopes: "read",
    });
    const single = await store.getOnlyInstallation();
    expect(single?.organization_id).toBe("org-only");
  });

  it("returns null when multiple installs exist (ambiguous)", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert({ organizationId: "org-a", accessToken: "a", scopes: "read" });
    await store.upsert({ organizationId: "org-b", accessToken: "b", scopes: "read" });
    expect(await store.getOnlyInstallation()).toBeNull();
  });

  it("delete returns true only when a row was removed", async () => {
    const db = new FakeD1();
    const store = new InstallationStore(db as unknown as D1Database);

    await store.upsert({ organizationId: "org-1", accessToken: "tok", scopes: "read" });
    expect(await store.delete("org-1")).toBe(true);
    expect(await store.delete("org-1")).toBe(false);
  });
});

describe("UserStore", () => {
  it("upserts a user keyed by (org, linear_user_id) and reads it back", async () => {
    const db = new FakeD1();
    const store = new UserStore(db as unknown as D1Database);

    await store.upsert({
      id: "u-1",
      organizationId: "org-1",
      linearUserId: "linear-user-1",
      email: "u@example.com",
      name: "U",
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: "2099-01-01T00:00:00Z",
      scopes: "read,write",
    });

    const row = await store.getByOrgAndLinearId("org-1", "linear-user-1");
    expect(row?.id).toBe("u-1");
    expect(row?.access_token).toBe("at-1");
    expect(row?.refresh_token).toBe("rt-1");
  });

  it("updateTokens refreshes the access/refresh/expiry tuple", async () => {
    const db = new FakeD1();
    const store = new UserStore(db as unknown as D1Database);

    await store.upsert({
      id: "u-1",
      organizationId: "org-1",
      linearUserId: "linear-user-1",
      accessToken: "at-old",
      refreshToken: "rt-old",
      expiresAt: "2024-01-01T00:00:00Z",
      scopes: "read",
    });
    await store.updateTokens({
      id: "u-1",
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresAt: "2099-01-01T00:00:00Z",
    });

    const row = await store.getById("u-1");
    expect(row?.access_token).toBe("at-new");
    expect(row?.refresh_token).toBe("rt-new");
    expect(row?.expires_at).toBe("2099-01-01T00:00:00Z");
  });
});

describe("OrgCredentialStore", () => {
  it("upserts a blob, lists the kind, and returns it on get", async () => {
    const db = new FakeD1();
    const store = new OrgCredentialStore(db as unknown as D1Database);
    const blob = {
      ciphertext: new Uint8Array([1, 2, 3]),
      dek_ciphertext: new Uint8Array([4, 5, 6]),
      kek_version: 1,
    };

    await store.upsert({
      organizationId: "org-1",
      kind: "anthropic_api_key",
      blob,
    });

    expect(await store.listKinds("org-1")).toEqual(["anthropic_api_key"]);
    const row = await store.get("org-1", "anthropic_api_key");
    expect(row?.kek_version).toBe(1);
    expect(Array.from(row!.ciphertext)).toEqual([1, 2, 3]);
  });

  it("delete returns false for missing rows", async () => {
    const db = new FakeD1();
    const store = new OrgCredentialStore(db as unknown as D1Database);
    expect(await store.delete("org-1", "no_such_kind")).toBe(false);
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
      organization_id: null,
      scope_override: null,
      system_prompt_override: null,
    });
  });

  it("respects explicit engine/model/max_turns values + per-team overrides", async () => {
    const db = new FakeD1();
    const store = new ProjectStore(db as unknown as D1Database);

    await store.upsert({
      teamId: "team-claude",
      repoUrl: "https://github.com/x/y.git",
      organizationId: "org-1",
      engine: "claude",
      model: "claude-sonnet-4-6",
      maxTurns: 25,
      defaultBranch: "trunk",
      scopeOverride: "marko",
      systemPromptOverride: "Be terse.",
    });

    const row = await store.get("team-claude");
    expect(row).toMatchObject({
      engine: "claude",
      model: "claude-sonnet-4-6",
      max_turns: 25,
      default_branch: "trunk",
      organization_id: "org-1",
      scope_override: "marko",
      system_prompt_override: "Be terse.",
    });
  });

  it("listForOrg returns only that org's projects", async () => {
    const db = new FakeD1();
    const store = new ProjectStore(db as unknown as D1Database);

    await store.upsert({ teamId: "team-a", repoUrl: "https://github.com/x/a.git", organizationId: "org-1" });
    await store.upsert({ teamId: "team-b", repoUrl: "https://github.com/x/b.git", organizationId: "org-2" });
    await store.upsert({ teamId: "team-c", repoUrl: "https://github.com/x/c.git", organizationId: "org-1" });

    const rows = await store.listForOrg("org-1");
    expect(rows.map((r) => r.team_id).sort()).toEqual(["team-a", "team-c"]);
  });
});
