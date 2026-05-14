import { describe, expect, it } from "vitest";
import {
  AgentSessionStore,
  GitHubInstallStore,
  InstallationStore,
  LinearAgentInstallStore,
  ProjectStore,
} from "../src/lib/store";
import { FakeD1 } from "./helpers/fake-d1";

// LinearAgentInstallStore is re-exported as InstallationStore for
// callers migrating from the v1 schema — both names are tested below
// to lock in that compatibility alias.

describe("LinearAgentInstallStore", () => {
  it("upserts and reads a row by organization_id", async () => {
    const db = new FakeD1();
    const store = new LinearAgentInstallStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      linearOrganizationId: "linear-org-1",
      accessToken: "token-abc",
      scopes: "read,write,app:assignable",
      installedByUserId: "user-1",
    });

    const row = await store.getByOrgId("org-1");
    expect(row?.organization_id).toBe("org-1");
    expect(row?.linear_organization_id).toBe("linear-org-1");
    expect(row?.access_token).toBe("token-abc");
    expect(row?.scopes).toBe("read,write,app:assignable");
    expect(row?.installed_by_user_id).toBe("user-1");
    expect(row?.status).toBe("active");
    expect(typeof row?.installed_at).toBe("number");
  });

  it("looks up by linear_organization_id for webhook routing", async () => {
    const db = new FakeD1();
    const store = new LinearAgentInstallStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      linearOrganizationId: "linear-org-abc",
      accessToken: "tok",
      scopes: "read",
      installedByUserId: "user-1",
    });

    const row = await store.getByLinearOrgId("linear-org-abc");
    expect(row?.organization_id).toBe("org-1");
    expect(row?.access_token).toBe("tok");
    expect(await store.getByLinearOrgId("nope")).toBeNull();
  });

  it("overwrites an existing row on conflict (by linear_organization_id)", async () => {
    const db = new FakeD1();
    const store = new LinearAgentInstallStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      linearOrganizationId: "linear-org-1",
      accessToken: "old-token",
      scopes: "read",
      installedByUserId: "user-1",
    });
    await store.upsert({
      organizationId: "org-1",
      linearOrganizationId: "linear-org-1",
      accessToken: "new-token",
      scopes: "read,write",
      installedByUserId: "user-1",
    });

    const row = await store.getByOrgId("org-1");
    expect(row?.access_token).toBe("new-token");
    expect(row?.scopes).toBe("read,write");
  });

  it("refreshToken updates access_token (+ optional refresh_token) by id", async () => {
    const db = new FakeD1();
    const store = new LinearAgentInstallStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      linearOrganizationId: "linear-org-1",
      accessToken: "tok",
      refreshToken: "refresh-1",
      scopes: "read",
      installedByUserId: "user-1",
    });
    const row = await store.getByOrgId("org-1");
    expect(row).not.toBeNull();

    await store.refreshToken(row!.id, "fresh-token", "fresh-refresh");

    const after = await store.getByOrgId("org-1");
    expect(after?.access_token).toBe("fresh-token");
    expect(after?.refresh_token).toBe("fresh-refresh");
  });

  it("delete returns true only when a row was removed", async () => {
    const db = new FakeD1();
    const store = new LinearAgentInstallStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      linearOrganizationId: "linear-org-1",
      accessToken: "tok",
      scopes: "read",
      installedByUserId: "user-1",
    });
    expect(await store.delete("org-1")).toBe(true);
    expect(await store.delete("org-1")).toBe(false);
  });

  it("exports InstallationStore as an alias for migration compatibility", () => {
    expect(InstallationStore).toBe(LinearAgentInstallStore);
  });
});

describe("ProjectStore", () => {
  it("upserts and reads a project by linear_team_id with defaults", async () => {
    const db = new FakeD1();
    const store = new ProjectStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      linearTeamId: "team-abc",
      repoUrl: "https://github.com/x/y.git",
    });

    const row = await store.getByTeamId("org-1", "team-abc");
    expect(row).toMatchObject({
      organization_id: "org-1",
      linear_team_id: "team-abc",
      repo_url: "https://github.com/x/y.git",
      default_branch: "main",
      engine: "pi",
      model: null,
      max_turns: 10,
      scope: null,
      system_prompt_override: null,
    });
    expect(typeof row?.id).toBe("string");
    expect(row?.id.length).toBeGreaterThan(0);
  });

  it("respects explicit engine/model/max_turns/scope values", async () => {
    const db = new FakeD1();
    const store = new ProjectStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      linearTeamId: "team-claude",
      repoUrl: "https://github.com/x/y.git",
      engine: "claude",
      model: "claude-sonnet-4-6",
      maxTurns: 25,
      defaultBranch: "trunk",
      scope: "enterprise",
      systemPromptOverride: "Be concise.",
    });

    const row = await store.getByTeamId("org-1", "team-claude");
    expect(row).toMatchObject({
      engine: "claude",
      model: "claude-sonnet-4-6",
      max_turns: 25,
      default_branch: "trunk",
      scope: "enterprise",
      system_prompt_override: "Be concise.",
    });
  });

  it("getByTeamId is scoped by organization_id", async () => {
    const db = new FakeD1();
    const store = new ProjectStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      linearTeamId: "team-abc",
      repoUrl: "https://github.com/x/y.git",
    });

    const row = await store.getByTeamId("org-1", "team-abc");
    expect(row?.linear_team_id).toBe("team-abc");
    expect(await store.getByTeamId("org-2", "team-abc")).toBeNull();
  });

  it("getById resolves a project by its UUID id and organization_id", async () => {
    const db = new FakeD1();
    const store = new ProjectStore(db as unknown as D1Database);

    const created = await store.upsert({
      organizationId: "org-1",
      linearTeamId: "team-abc",
      repoUrl: "https://github.com/x/y.git",
    });
    expect(created).not.toBeNull();

    const byId = await store.getById(created!.id, "org-1");
    expect(byId?.linear_team_id).toBe("team-abc");
    // Cross-org lookup must miss.
    expect(await store.getById(created!.id, "org-2")).toBeNull();
  });

  it("listByOrg filters to the requested organization_id", async () => {
    const db = new FakeD1();
    const store = new ProjectStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      linearTeamId: "team-a",
      repoUrl: "https://github.com/x/a.git",
    });
    await store.upsert({
      organizationId: "org-1",
      linearTeamId: "team-b",
      repoUrl: "https://github.com/x/b.git",
    });
    await store.upsert({
      organizationId: "org-2",
      linearTeamId: "team-c",
      repoUrl: "https://github.com/x/c.git",
    });

    const org1Rows = await store.listByOrg("org-1");
    expect(org1Rows).toHaveLength(2);
    expect(org1Rows.map((r) => r.linear_team_id).sort()).toEqual(["team-a", "team-b"]);
  });

  it("delete requires both organization_id and linear_team_id", async () => {
    const db = new FakeD1();
    const store = new ProjectStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      linearTeamId: "team-abc",
      repoUrl: "https://github.com/x/y.git",
    });

    expect(await store.delete("org-1", "team-abc")).toBe(true);
    expect(await store.delete("org-1", "team-abc")).toBe(false);
  });
});

describe("GitHubInstallStore", () => {
  it("upserts and reads a row keyed by organization_id", async () => {
    const db = new FakeD1();
    const store = new GitHubInstallStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      installId: 99999,
      accountLogin: "acme-corp",
    });

    const row = await store.getByOrgId("org-1");
    expect(row?.organization_id).toBe("org-1");
    expect(row?.install_id).toBe(99999);
    expect(row?.account_login).toBe("acme-corp");
    expect(row?.account_type).toBe("Organization");
    expect(row?.repo_selection).toBe("all");
  });

  it("delete removes by organization_id", async () => {
    const db = new FakeD1();
    const store = new GitHubInstallStore(db as unknown as D1Database);

    await store.upsert({
      organizationId: "org-1",
      installId: 123,
      accountLogin: "acme",
    });
    expect(await store.delete("org-1")).toBe(true);
    expect(await store.getByOrgId("org-1")).toBeNull();
    expect(await store.delete("org-1")).toBe(false);
  });
});

describe("AgentSessionStore", () => {
  it("creates a row with organization_id and round-trips via get()", async () => {
    const db = new FakeD1();
    const store = new AgentSessionStore(db as unknown as D1Database);

    await store.create({
      id: "session-1",
      organizationId: "org-1",
      linearIssueId: "issue-1",
      linearIssueIdentifier: "SYM-123",
      linearIssueTitle: "Add date to README",
      triggeredBy: "created",
      team: "SYM",
      repo: "https://github.com/x/y.git",
      prompt: "do the thing",
      configSnapshot: { model: "claude", max_turns: 5 },
    });

    const row = await store.get("session-1");
    expect(row).not.toBeNull();
    expect(row?.organization_id).toBe("org-1");
    expect(row?.linear_issue_id).toBe("issue-1");
    expect(row?.linear_issue_identifier).toBe("SYM-123");
    expect(row?.status).toBe("running");
    expect(row?.team).toBe("SYM");
    expect(JSON.parse(row?.config_snapshot ?? "{}")).toMatchObject({
      model: "claude",
      max_turns: 5,
    });
  });

  it("update applies status/completedAt/error in a single statement", async () => {
    const db = new FakeD1();
    const store = new AgentSessionStore(db as unknown as D1Database);

    await store.create({ id: "session-2", organizationId: "org-1" });
    await store.update("session-2", {
      status: "complete",
      completedAt: 1700000000,
      error: null,
    });

    const row = await store.get("session-2");
    expect(row?.status).toBe("complete");
    expect(row?.completed_at).toBe(1700000000);
    expect(row?.error).toBeNull();
  });

  it("list() filters by organizationId", async () => {
    const db = new FakeD1();
    const store = new AgentSessionStore(db as unknown as D1Database);

    await store.create({ id: "s-a", organizationId: "org-1" });
    await store.create({ id: "s-b", organizationId: "org-1" });
    await store.create({ id: "s-c", organizationId: "org-2" });

    const org1 = await store.list({ organizationId: "org-1" });
    expect(org1.map((r) => r.id).sort()).toEqual(["s-a", "s-b"]);
  });

  it("listRunning() filters by status='running' (and optional org)", async () => {
    const db = new FakeD1();
    const store = new AgentSessionStore(db as unknown as D1Database);

    await store.create({ id: "running-1", organizationId: "org-1" });
    await store.create({ id: "done-1", organizationId: "org-1" });
    await store.update("done-1", { status: "complete" });

    const running = await store.listRunning("org-1");
    expect(running.map((r) => r.id)).toEqual(["running-1"]);

    const allRunning = await store.listRunning();
    expect(allRunning.map((r) => r.id)).toEqual(["running-1"]);
  });
});
