import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { Env } from "../src/index";

const kv = (env as unknown as Env).OAUTH_KV;

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

async function callWorker(request: Request): Promise<Response> {
  return SELF.fetch(request);
}

async function sha256Base64Url(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("GET /health", () => {
  it("returns ok: true", async () => {
    const request = makeRequest("http://localhost/health");
    const response = await callWorker(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  });
});

describe("GET /authorize", () => {
  it("returns 400 when params are missing", async () => {
    const request = makeRequest("http://localhost/authorize");
    const response = await callWorker(request);
    expect(response.status).toBe(400);
  });

  it("returns 400 for unsupported provider", async () => {
    const request = makeRequest(
      "http://localhost/authorize?provider=unsupported&state=test&code_challenge=abc",
    );
    const response = await callWorker(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("unsupported provider");
  });

  it("redirects to Linear authorize URL with correct params", async () => {
    const request = makeRequest(
      "http://localhost/authorize?provider=linear&state=test123&code_challenge=abc",
      { redirect: "manual" },
    );
    const response = await callWorker(request);
    expect(response.status).toBe(302);
    const location = response.headers.get("Location");
    expect(location).toBeTruthy();
    expect(location).toContain("linear.app/oauth/authorize");
    expect(location).toContain("state=test123");
    expect(location).toContain("code_challenge=abc");
    expect(location).toContain("code_challenge_method=S256");
    expect(location).toContain("response_type=code");
    expect(location).toContain("scope=read");
  });

  it("redirects to GitHub authorize URL", async () => {
    const request = makeRequest(
      "http://localhost/authorize?provider=github&state=gh-state&code_challenge=xyz",
      { redirect: "manual" },
    );
    const response = await callWorker(request);
    expect(response.status).toBe(302);
    const location = response.headers.get("Location");
    expect(location).toBeTruthy();
    expect(location).toContain("github.com/login/oauth/authorize");
    expect(location).toContain("state=gh-state");
    expect(location).toContain("repo");
  });

  it("stores pending entry in KV", async () => {
    const request = makeRequest(
      "http://localhost/authorize?provider=linear&state=kv-test&code_challenge=challenge123",
    );
    await callWorker(request);

    const stored = await kv.get("oauth:pending:kv-test");
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!) as { provider: string; code_challenge: string };
    expect(parsed.provider).toBe("linear");
    expect(parsed.code_challenge).toBe("challenge123");
  });
});

describe("POST /token", () => {
  it("returns 400 for invalid JSON", async () => {
    const request = makeRequest("http://localhost/token", {
      method: "POST",
      body: "not json",
    });
    const response = await callWorker(request);
    expect(response.status).toBe(400);
  });

  it("returns 400 when required fields are missing", async () => {
    const request = makeRequest("http://localhost/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "only-state" }),
    });
    const response = await callWorker(request);
    expect(response.status).toBe(400);
  });

  it("returns 202 when auth is still pending", async () => {
    await kv.put(
      "oauth:pending:pending-state",
      JSON.stringify({ provider: "linear", code_challenge: "abc" }),
    );

    const request = makeRequest("http://localhost/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "pending-state", code_verifier: "any" }),
    });
    const response = await callWorker(request);
    expect(response.status).toBe(202);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("pending");
  });

  it("returns 410 when state is expired/unknown", async () => {
    const request = makeRequest("http://localhost/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "unknown-state", code_verifier: "any" }),
    });
    const response = await callWorker(request);
    expect(response.status).toBe(410);
  });

  it("returns 401 when code_verifier is wrong", async () => {
    const codeChallenge = await sha256Base64Url("correct-verifier");

    await kv.put(
      "oauth:token:pkce-test",
      JSON.stringify({
        access_token: "at_123",
        refresh_token: "rt_123",
        code_challenge: codeChallenge,
      }),
    );

    const request = makeRequest("http://localhost/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "pkce-test", code_verifier: "wrong-verifier" }),
    });
    const response = await callWorker(request);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("invalid code_verifier");
  });

  it("returns tokens when code_verifier is correct", async () => {
    const verifier = "correct-verifier-for-success";
    const codeChallenge = await sha256Base64Url(verifier);

    await kv.put(
      "oauth:token:success-test",
      JSON.stringify({
        access_token: "at_good",
        refresh_token: "rt_good",
        expires_at: 9999999999,
        scope: "read,write",
        code_challenge: codeChallenge,
      }),
    );

    const request = makeRequest("http://localhost/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "success-test", code_verifier: verifier }),
    });
    const response = await callWorker(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.access_token).toBe("at_good");
    expect(body.refresh_token).toBe("rt_good");
    expect(body.scope).toBe("read,write");
    expect(body.code_challenge).toBeUndefined();
  });

  it("returns 410 on second call (single-use tokens)", async () => {
    const verifier = "single-use-verifier";
    const codeChallenge = await sha256Base64Url(verifier);

    await kv.put(
      "oauth:token:single-use",
      JSON.stringify({
        access_token: "at_once",
        code_challenge: codeChallenge,
      }),
    );

    // First call — succeeds
    const req1 = makeRequest("http://localhost/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "single-use", code_verifier: verifier }),
    });
    const res1 = await callWorker(req1);
    expect(res1.status).toBe(200);

    // Second call — expired
    const req2 = makeRequest("http://localhost/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "single-use", code_verifier: verifier }),
    });
    const res2 = await callWorker(req2);
    expect(res2.status).toBe(410);
  });
});

describe("404 handling", () => {
  it("returns 404 for unknown routes", async () => {
    const request = makeRequest("http://localhost/unknown");
    const response = await callWorker(request);
    expect(response.status).toBe(404);
  });
});
