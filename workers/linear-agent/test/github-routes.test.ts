import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type Env } from "../src/index";
import { FakeD1 } from "./helpers/fake-d1";

class FakeKV {
  store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string) {
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

function makeEnv(db: FakeD1, overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    LINEAR_TOKENS: new FakeKV() as unknown as KVNamespace,
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
    const res = await app.fetch(
      new Request("https://agent.example/github/install"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "github_app_not_configured" });
  });

  it("redirects to GitHub when slug is configured", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const res = await app.fetch(
      new Request("https://agent.example/github/install"),
      makeEnv(db, { GITHUB_APP_SLUG: "symphony-dev" }),
      makeExecCtx(),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toContain(
      "https://github.com/apps/symphony-dev/installations/new",
    );
    expect(location).toContain("state=");
  });
});

describe("GET /github/install/callback", () => {
  it("returns 400 when installation_id is missing", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const res = await app.fetch(
      new Request("https://agent.example/github/install/callback"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_installation_id" });
  });

  it("returns 503 when GitHub App credentials are missing", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const res = await app.fetch(
      new Request(
        "https://agent.example/github/install/callback?installation_id=12345&org_id=test-org",
      ),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "github_app_not_configured" });
  });

  it("stores installation_id via updateGitHubAppInstallation", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const now = new Date().toISOString();
    db.installations.set("test-org", {
      id: 1,
      org_id: "test-org",
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
      vi.fn().mockResolvedValue(new Response("not found", { status: 404 })),
    );

    const res = await app.fetch(
      new Request(
        "https://agent.example/github/install/callback?installation_id=99999&org_id=test-org",
      ),
      makeEnv(db, {
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
      }),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.installation_id).toBe(99999);

    const row = db.installations.get("test-org")!;
    expect(row.github_app_installation_id).toBe(99999);
  });
});

describe("admin credential routes", () => {
  it("rejects unauthenticated request", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const res = await app.fetch(
      new Request("https://agent.example/admin/credentials/org-1/github_pat", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "ghp_test" }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 503 when CREDENTIAL_KEK is not configured", async () => {
    const app = buildApp();
    const db = new FakeD1();
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
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "encryption_not_configured" });
  });

  it("stores and lists encrypted PAT credentials", async () => {
    const app = buildApp();
    const db = new FakeD1();
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
      makeEnv(db, { CREDENTIAL_KEK: kek }),
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
      makeEnv(db, { CREDENTIAL_KEK: kek }),
      makeExecCtx(),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as Record<string, unknown>;
    expect(listBody.credential_types).toEqual(["github_pat"]);
  });

  it("deletes a PAT credential", async () => {
    const app = buildApp();
    const db = new FakeD1();
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
      makeEnv(db, { CREDENTIAL_KEK: kek }),
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
      makeEnv(db, { CREDENTIAL_KEK: kek }),
      makeExecCtx(),
    );
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as Record<string, unknown>;
    expect(delBody.ok).toBe(true);
    expect(db.orgCredentials.has("org-1:github_pat")).toBe(false);
  });
});
