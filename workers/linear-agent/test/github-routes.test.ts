import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type Env } from "../src/index";
import { FakeD1 } from "./helpers/fake-d1";

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
  const raw = await crypto.subtle.exportKey("raw", key);
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

describe("GET /github/install", () => {
  it("returns 503 when GITHUB_APP_SLUG is unset", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    const res = await app.fetch(
      new Request("https://agent.example/github/install"),
      makeEnv(db, kv),
      makeExecCtx(),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "github_app_not_configured" });
  });

  it("redirects to GitHub and stores state in KV", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    const res = await app.fetch(
      new Request("https://agent.example/github/install"),
      makeEnv(db, kv, { GITHUB_APP_SLUG: "symphony-dev" }),
      makeExecCtx(),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toContain(
      "https://github.com/apps/symphony-dev/installations/new",
    );
    expect(location).toContain("state=");

    const stateParam = new URL(location).searchParams.get("state")!;
    expect(kv.store.has(`gh_install_state:${stateParam}`)).toBe(true);
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
    const res = await app.fetch(
      new Request(
        "https://agent.example/github/install/callback?installation_id=12345",
      ),
      makeEnv(db, kv),
      makeExecCtx(),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "github_app_not_configured" });
  });

  it("verifies installation via GitHub API and stores install_id", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    const now = new Date().toISOString();
    db.installations.set("acme-corp", {
      id: 1,
      org_id: "acme-corp",
      access_token: "tok",
      refresh_token: null,
      scopes: "read,write",
      installed_by: "user-1",
      status: "active",
      github_app_installation_id: null,
      installed_at: now,
      refreshed_at: now,
    });

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
        "https://agent.example/github/install/callback?installation_id=99999",
      ),
      makeEnv(db, kv, {
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY:
          "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
      }),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.installation_id).toBe(99999);
    expect(body.account_login).toBe("acme-corp");

    const row = db.installations.get("acme-corp")!;
    expect(row.github_app_installation_id).toBe(99999);
  });

  it("returns 502 when GitHub API verification fails", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not found", { status: 404 })),
    );

    const res = await app.fetch(
      new Request(
        "https://agent.example/github/install/callback?installation_id=99999",
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
