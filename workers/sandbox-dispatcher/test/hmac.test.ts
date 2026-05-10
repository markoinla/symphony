import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { computeSignature, hmacMiddleware, type HmacEnv } from "../src/hmac";

const SECRET = "test-secret-do-not-use-in-prod";

interface TestEnv extends HmacEnv {}

function makeApp() {
  const app = new Hono<{ Bindings: TestEnv }>();
  app.use("*", hmacMiddleware);
  app.get("/health", (c) => c.json({ ok: true }));
  app.post("/echo", async (c) => c.json({ received: await c.req.text() }));
  return app;
}

const env: TestEnv = { DISPATCH_HMAC_SECRET: SECRET };

describe("hmacMiddleware", () => {
  it("exempts /health (no signature required)", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("https://example/health"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects requests with no signature header", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("https://example/echo", { method: "POST", body: "{}" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_signature" });
  });

  it("rejects requests with an incorrect signature", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("https://example/echo", {
        method: "POST",
        body: "{}",
        headers: { "X-Symphony-Signature": "deadbeef" },
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
  });

  it("accepts requests with a correctly computed signature", async () => {
    const app = makeApp();
    const body = JSON.stringify({ scope: "alice", issue_id: "MT-32" });
    const sig = await computeSignature(SECRET, body);

    const res = await app.fetch(
      new Request("https://example/echo", {
        method: "POST",
        body,
        headers: { "X-Symphony-Signature": sig },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: body });
  });

  it("treats signatures as constant-time-comparable hex (case sensitive)", async () => {
    // computeSignature returns lowercase hex; uppercase shouldn't be accepted.
    const app = makeApp();
    const body = "payload";
    const sig = (await computeSignature(SECRET, body)).toUpperCase();

    const res = await app.fetch(
      new Request("https://example/echo", {
        method: "POST",
        body,
        headers: { "X-Symphony-Signature": sig },
      }),
      env,
    );

    expect(res.status).toBe(401);
  });

  it("requires the signature on GET requests too (/health is the only exemption)", async () => {
    const app = makeApp();
    app.get("/state", (c) => c.json({ ok: true }));

    const unsigned = await app.fetch(new Request("https://example/state"), env);
    expect(unsigned.status).toBe(401);

    const sig = await computeSignature(SECRET, "");
    const signed = await app.fetch(
      new Request("https://example/state", {
        headers: { "X-Symphony-Signature": sig },
      }),
      env,
    );
    expect(signed.status).toBe(200);
  });

  it("returns 500 if DISPATCH_HMAC_SECRET is missing", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("https://example/echo", {
        method: "POST",
        body: "{}",
        headers: { "X-Symphony-Signature": "anything" },
      }),
      { DISPATCH_HMAC_SECRET: "" },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "dispatcher_misconfigured" });
  });
});
