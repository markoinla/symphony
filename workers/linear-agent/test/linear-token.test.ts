import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveLinearMcpToken } from "../src/lib/linear-token";
import { UserStore } from "../src/lib/store";
import { FakeD1 } from "./helpers/fake-d1";

function makeUserStore() {
  const db = new FakeD1();
  return { db, store: new UserStore(db as unknown as D1Database) };
}

const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const nearExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString();
const expired = new Date(Date.now() - 60 * 1000).toISOString();

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockRefreshSuccess(
  newToken = "refreshed-access",
  newRefresh = "refreshed-refresh",
) {
  globalThis.fetch = vi.fn(async () =>
    new Response(
      JSON.stringify({
        access_token: newToken,
        refresh_token: newRefresh,
        expires_in: 36000,
      }),
      { status: 200 },
    ),
  ) as typeof fetch;
}

function mockRefreshFailure() {
  globalThis.fetch = vi.fn(async () =>
    new Response("invalid_grant", { status: 400 }),
  ) as typeof fetch;
}

describe("resolveLinearMcpToken", () => {
  it("returns null when no users exist for the org", async () => {
    const { store } = makeUserStore();
    const result = await resolveLinearMcpToken({
      orgId: "org-1",
      triggeringUserId: null,
      userStore: store,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      runTimeoutMs: RUN_TIMEOUT_MS,
    });
    expect(result).toBeNull();
  });

  it("picks the triggering user when they have a valid token", async () => {
    const { store } = makeUserStore();
    await store.upsert({
      linearUserId: "user-trigger",
      organizationId: "org-1",
      accessToken: "trigger-token",
      expiresAt: farFuture,
    });
    await store.upsert({
      linearUserId: "user-installer",
      organizationId: "org-1",
      accessToken: "installer-token",
      expiresAt: farFuture,
    });

    const result = await resolveLinearMcpToken({
      orgId: "org-1",
      triggeringUserId: "user-trigger",
      userStore: store,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      runTimeoutMs: RUN_TIMEOUT_MS,
    });

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe("trigger-token");
    expect(result!.userId).toBe("user-trigger");
    expect(result!.refreshed).toBe(false);
  });

  it("falls back to installer when triggering user not in users table", async () => {
    const { store } = makeUserStore();
    await store.upsert({
      linearUserId: "user-installer",
      organizationId: "org-1",
      accessToken: "installer-token",
      expiresAt: farFuture,
    });

    const result = await resolveLinearMcpToken({
      orgId: "org-1",
      triggeringUserId: "user-unknown",
      userStore: store,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      runTimeoutMs: RUN_TIMEOUT_MS,
    });

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe("installer-token");
    expect(result!.userId).toBe("user-installer");
  });

  it("refreshes token when it expires within run window", async () => {
    const { store } = makeUserStore();
    await store.upsert({
      linearUserId: "user-1",
      organizationId: "org-1",
      accessToken: "old-token",
      refreshToken: "old-refresh",
      expiresAt: nearExpiry,
    });

    mockRefreshSuccess("fresh-token", "fresh-refresh");

    const result = await resolveLinearMcpToken({
      orgId: "org-1",
      triggeringUserId: null,
      userStore: store,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      runTimeoutMs: RUN_TIMEOUT_MS,
    });

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe("fresh-token");
    expect(result!.refreshed).toBe(true);

    const updated = await store.getByLinearUserId("user-1");
    expect(updated!.access_token).toBe("fresh-token");
    expect(updated!.refresh_token).toBe("fresh-refresh");
  });

  it("falls back to next candidate on refresh failure", async () => {
    const { store } = makeUserStore();
    await store.upsert({
      linearUserId: "user-trigger",
      organizationId: "org-1",
      accessToken: "expiring-token",
      refreshToken: "bad-refresh",
      expiresAt: expired,
    });
    await store.upsert({
      linearUserId: "user-installer",
      organizationId: "org-1",
      accessToken: "good-installer-token",
      expiresAt: farFuture,
    });

    mockRefreshFailure();

    const result = await resolveLinearMcpToken({
      orgId: "org-1",
      triggeringUserId: "user-trigger",
      userStore: store,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      runTimeoutMs: RUN_TIMEOUT_MS,
    });

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe("good-installer-token");
    expect(result!.userId).toBe("user-installer");
    expect(result!.refreshed).toBe(false);
  });

  it("returns null when all tokens need refresh and all fail", async () => {
    const { store } = makeUserStore();
    await store.upsert({
      linearUserId: "user-1",
      organizationId: "org-1",
      accessToken: "expired-1",
      refreshToken: "bad-refresh-1",
      expiresAt: expired,
    });
    await store.upsert({
      linearUserId: "user-2",
      organizationId: "org-1",
      accessToken: "expired-2",
      refreshToken: "bad-refresh-2",
      expiresAt: expired,
    });

    mockRefreshFailure();

    const result = await resolveLinearMcpToken({
      orgId: "org-1",
      triggeringUserId: null,
      userStore: store,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      runTimeoutMs: RUN_TIMEOUT_MS,
    });

    expect(result).toBeNull();
  });

  it("returns null when token needs refresh but has no refresh_token", async () => {
    const { store } = makeUserStore();
    await store.upsert({
      linearUserId: "user-1",
      organizationId: "org-1",
      accessToken: "expiring-no-refresh",
      refreshToken: null,
      expiresAt: expired,
    });

    const result = await resolveLinearMcpToken({
      orgId: "org-1",
      triggeringUserId: null,
      userStore: store,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      runTimeoutMs: RUN_TIMEOUT_MS,
    });

    expect(result).toBeNull();
  });

  it("does not refresh when expires_at is null (no expiry info)", async () => {
    const { store } = makeUserStore();
    await store.upsert({
      linearUserId: "user-1",
      organizationId: "org-1",
      accessToken: "no-expiry-token",
      expiresAt: null,
    });

    const result = await resolveLinearMcpToken({
      orgId: "org-1",
      triggeringUserId: null,
      userStore: store,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      runTimeoutMs: RUN_TIMEOUT_MS,
    });

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe("no-expiry-token");
    expect(result!.refreshed).toBe(false);
  });

  it("ignores triggering user from a different org", async () => {
    const { store } = makeUserStore();
    await store.upsert({
      linearUserId: "user-other-org",
      organizationId: "org-2",
      accessToken: "other-org-token",
      expiresAt: farFuture,
    });
    await store.upsert({
      linearUserId: "user-installer",
      organizationId: "org-1",
      accessToken: "correct-org-token",
      expiresAt: farFuture,
    });

    const result = await resolveLinearMcpToken({
      orgId: "org-1",
      triggeringUserId: "user-other-org",
      userStore: store,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      runTimeoutMs: RUN_TIMEOUT_MS,
    });

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe("correct-org-token");
    expect(result!.userId).toBe("user-installer");
  });

  it("does not duplicate triggering user in candidate list", async () => {
    const { store } = makeUserStore();
    await store.upsert({
      linearUserId: "user-1",
      organizationId: "org-1",
      accessToken: "valid-token",
      expiresAt: farFuture,
    });

    const result = await resolveLinearMcpToken({
      orgId: "org-1",
      triggeringUserId: "user-1",
      userStore: store,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      runTimeoutMs: RUN_TIMEOUT_MS,
    });

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe("valid-token");
    expect(result!.userId).toBe("user-1");
  });
});
