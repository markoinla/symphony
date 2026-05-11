import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type Env } from "../src/index";
import { FakeD1 } from "./helpers/fake-d1";

// Stub the GitHub App JWT signer so tests don't need a real RSA private
// key. The route calls `createAppJwt` to mint an app-level JWT before
// hitting GitHub's `/app/installations/:id` endpoint; the fake key we
// pass in `GITHUB_APP_PRIVATE_KEY` is not a real PEM, so the real
// implementation throws ASN.1 errors. We mock to a sentinel JWT.
vi.mock("../src/lib/github-app", () => ({
  createAppJwt: vi.fn().mockResolvedValue("test.jwt.token"),
  mintInstallationToken: vi.fn().mockResolvedValue("ghs_mocked_installation_token"),
}));

class FakeKV {
  store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string, _opts?: unknown) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

async function generateKekBase64(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["wrapKey", "unwrapKey"],
  )) as CryptoKey;
  // `crypto.subtle.exportKey('raw', ...)` returns ArrayBuffer for a
  // symmetric AES key; the lib.dom signature widens it to
  // `ArrayBuffer | JsonWebKey`, so we narrow with a cast.
  const raw = (await crypto.subtle.exportKey("raw", key)) as ArrayBuffer;
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

function makeEnv(
  db: FakeD1,
  kv: FakeKV,
  overrides: Partial<Env> = {},
): Env {
  return {
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    LINEAR_TOKENS: kv as unknown as KVNamespace,
    SESSION_RUNNER: { create: vi.fn() } as unknown as Workflow,
    DB: db as unknown as D1Database,
    LINEAR_CLIENT_ID: "client",
    LINEAR_CLIENT_SECRET: "secret",
    LINEAR_WEBHOOK_SECRET: "wh-secret",
    DISPATCHER_URL: "https://dispatcher.example",
    DISPATCH_HMAC_SECRET: "hmac-secret",
    URL: "https://agent.example",
    DEFAULT_SCOPE: "default",
    DEFAULT_MODEL: "anthropic/claude-sonnet-4-6",
    DEFAULT_ENGINE: "pi",
    ADMIN_TOKEN: "admin-secret",
    ...overrides,
  };
}

function makeExecCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

function authed(req: Request, token = "admin-secret"): Request {
  const headers = new Headers(req.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return new Request(req, { headers });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// GET /github/install runs through Better Auth's `requireOrg` middleware
// before checking GITHUB_APP_SLUG. Without a live Better Auth session
// (which would require running the auth handler with a real D1 + cookie
// jar) every unauthenticated test hits 401. We assert that 401 path
// rather than skipping the route entirely.
describe("GET /github/install (without Better Auth session)", () => {
  it("returns 401 for unauthenticated requests, regardless of GITHUB_APP_SLUG", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    const res = await app.fetch(
      new Request("https://agent.example/github/install"),
      makeEnv(db, kv),
      makeExecCtx(),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("still returns 401 even when GITHUB_APP_SLUG is configured", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    const res = await app.fetch(
      new Request("https://agent.example/github/install"),
      makeEnv(db, kv, { GITHUB_APP_SLUG: "symphony-dev" }),
      makeExecCtx(),
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /github/install/callback", () => {
  it("returns 400 when installation_id is missing", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    const res = await app.fetch(
      new Request("https://agent.example/github/install/callback"),
      makeEnv(db, kv),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_installation_id" });
  });

  it("returns 400 when state is missing", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    const res = await app.fetch(
      new Request(
        "https://agent.example/github/install/callback?installation_id=12345",
      ),
      makeEnv(db, kv),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_state" });
  });

  it("returns 400 for invalid/expired state", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    const res = await app.fetch(
      new Request(
        "https://agent.example/github/install/callback?installation_id=123&state=bad-state",
      ),
      makeEnv(db, kv, {
        GITHUB_APP_ID: "app-123",
        GITHUB_APP_PRIVATE_KEY: "fake",
      }),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_or_expired_state" });
  });

  it("returns 503 when GitHub App credentials are missing", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    await kv.put(
      "gh_install_state:state-1",
      JSON.stringify({ orgId: "org-1" }),
    );

    const res = await app.fetch(
      new Request(
        "https://agent.example/github/install/callback?installation_id=12345&state=state-1",
      ),
      makeEnv(db, kv),
      makeExecCtx(),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "github_app_not_configured" });
  });

  it("verifies installation via GitHub API and stores it in github_installs", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    await kv.put(
      "gh_install_state:state-2",
      JSON.stringify({ orgId: "org-1" }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 99999,
            account: { login: "acme-corp", type: "Organization" },
            repository_selection: "all",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const res = await app.fetch(
      new Request(
        "https://agent.example/github/install/callback?installation_id=99999&state=state-2",
      ),
      makeEnv(db, kv, {
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY:
          "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
      }),
      makeExecCtx(),
    );
    // The handler redirects to the dashboard integrations tab after a
    // successful install verification.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/dashboard/settings/integrations",
    );

    const ghInstall = db.githubInstalls.get("org-1");
    expect(ghInstall).toBeDefined();
    expect(ghInstall!.install_id).toBe(99999);
    expect(ghInstall!.account_login).toBe("acme-corp");
    expect(ghInstall!.account_type).toBe("Organization");
    expect(ghInstall!.repo_selection).toBe("all");
  });

  it("returns 502 when GitHub API verification fails", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    await kv.put(
      "gh_install_state:state-3",
      JSON.stringify({ orgId: "org-1" }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not found", { status: 404 })),
    );

    const res = await app.fetch(
      new Request(
        "https://agent.example/github/install/callback?installation_id=99999&state=state-3",
      ),
      makeEnv(db, kv, {
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY:
          "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
      }),
      makeExecCtx(),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("github_installation_verification_failed");
  });
});

describe("admin credential routes", () => {
  it("rejects unauthenticated request", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    const res = await app.fetch(
      new Request("https://agent.example/admin/credentials/org-1/github_pat", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "ghp_test" }),
      }),
      makeEnv(db, kv),
      makeExecCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 503 when CREDENTIAL_KEK is not configured", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    const res = await app.fetch(
      authed(
        new Request(
          "https://agent.example/admin/credentials/org-1/github_pat",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: "ghp_test" }),
          },
        ),
      ),
      makeEnv(db, kv),
      makeExecCtx(),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "encryption_not_configured" });
  });

  it("stores and lists encrypted PAT credentials", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    const kek = await generateKekBase64();

    const putRes = await app.fetch(
      authed(
        new Request(
          "https://agent.example/admin/credentials/org-1/github_pat",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: "ghp_secret_token_123" }),
          },
        ),
      ),
      makeEnv(db, kv, { CREDENTIAL_KEK: kek }),
      makeExecCtx(),
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as Record<string, unknown>;
    expect(putBody.ok).toBe(true);
    expect(putBody.credential_type).toBe("github_pat");

    expect(db.orgCredentials.has("org-1:github_pat")).toBe(true);
    const stored = db.orgCredentials.get("org-1:github_pat")!;
    expect(stored.ciphertext).toBeInstanceOf(ArrayBuffer);

    const listRes = await app.fetch(
      authed(
        new Request("https://agent.example/admin/credentials/org-1"),
      ),
      makeEnv(db, kv, { CREDENTIAL_KEK: kek }),
      makeExecCtx(),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as Record<string, unknown>;
    expect(listBody.credential_types).toEqual(["github_pat"]);
  });

  it("deletes a PAT credential", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    const kek = await generateKekBase64();

    await app.fetch(
      authed(
        new Request(
          "https://agent.example/admin/credentials/org-1/github_pat",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: "ghp_to_delete" }),
          },
        ),
      ),
      makeEnv(db, kv, { CREDENTIAL_KEK: kek }),
      makeExecCtx(),
    );
    expect(db.orgCredentials.has("org-1:github_pat")).toBe(true);

    const delRes = await app.fetch(
      authed(
        new Request(
          "https://agent.example/admin/credentials/org-1/github_pat",
          { method: "DELETE" },
        ),
      ),
      makeEnv(db, kv, { CREDENTIAL_KEK: kek }),
      makeExecCtx(),
    );
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as Record<string, unknown>;
    expect(delBody.ok).toBe(true);
    expect(db.orgCredentials.has("org-1:github_pat")).toBe(false);
  });
});
