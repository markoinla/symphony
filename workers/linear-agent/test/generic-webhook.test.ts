import { describe, expect, it } from "vitest";

import { buildApp, type Env } from "../src/index";
import { readJsonPath } from "../src/lib/json-path";
import { computeHmacSignature, verifyHmacSignature } from "../src/lib/signature";
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

function makeEnv(kv: FakeKV, db = new FakeD1()): Env {
  return {
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    LINEAR_TOKENS: kv as unknown as KVNamespace,
    SESSION_RUNNER: { create: async () => ({ id: "stub" }) } as unknown as Workflow,
    DB: db as unknown as D1Database,
    LINEAR_CLIENT_ID: "client",
    LINEAR_CLIENT_SECRET: "secret",
    LINEAR_WEBHOOK_SECRET: "linear-secret",
    DISPATCHER_URL: "https://dispatcher.example",
    DISPATCH_HMAC_SECRET: "dispatch-secret",
    URL: "https://agent.example",
    DEFAULT_SCOPE: "default",
    DEFAULT_MODEL: "anthropic/claude-sonnet-4-6",
    DEFAULT_ENGINE: "pi",
  };
}

function makeCtx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

async function signedRequest(sourceId: string, body: Record<string, unknown>, secret: string, algorithm: "sha1" | "sha256" = "sha256") {
  const raw = JSON.stringify(body);
  const sig = await computeHmacSignature(secret, raw, algorithm);
  return new Request(`https://agent.example/webhook/source/${sourceId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Webhook-Signature": sig },
    body: raw,
  });
}

describe("generic webhook helpers", () => {
  it("verifies configurable HMAC algorithms", async () => {
    const body = JSON.stringify({ ok: true });
    const sha256 = await computeHmacSignature("secret", body, "sha256");
    const sha1 = await computeHmacSignature("secret", body, "sha1");

    await expect(verifyHmacSignature("secret", body, sha256, "sha256")).resolves.toBe(true);
    await expect(verifyHmacSignature("secret", body, `sha1=${sha1}`, "sha1")).resolves.toBe(true);
    await expect(verifyHmacSignature("secret", body, sha1, "sha256")).resolves.toBe(false);
    await expect(verifyHmacSignature("secret", body, "deadbeef", "sha1")).resolves.toBe(false);
  });

  it("extracts values with the supported JSONPath subset", () => {
    const payload = { event: { id: "deploy-1", type: "deploy.success" }, items: [{ id: 42 }] };
    expect(readJsonPath(payload, "$.event.id")).toBe("deploy-1");
    expect(readJsonPath(payload, "$.items[0].id")).toBe(42);
    expect(readJsonPath(payload, "$.missing.id")).toBeNull();
    expect(readJsonPath(payload, "not-jsonpath")).toBeNull();
  });
});

describe("POST /webhook/source/:id", () => {
  it("rejects invalid signatures and dedupes repeated external ids", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const kv = new FakeKV();
    db.webhookSources.set("src-1", {
      id: "src-1",
      organization_id: "org-1",
      name: "Generic",
      kind: "generic",
      enabled: 1,
      secret: "source-secret",
      project_id: null,
      config: JSON.stringify({
        external_id_path: "$.event.id",
        signature_header: "X-Webhook-Signature",
        signature_algorithm: "sha256",
      }),
      created_at: 1,
      updated_at: 1,
      last_used_at: null,
    });

    const bad = await app.fetch(
      new Request("https://agent.example/webhook/source/src-1", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Webhook-Signature": "bad" },
        body: JSON.stringify({ event: { id: "deploy-1" } }),
      }),
      makeEnv(kv, db),
      makeCtx(),
    );
    expect(bad.status).toBe(401);

    const first = await app.fetch(
      await signedRequest("src-1", { event: { id: "deploy-1" } }, "source-secret"),
      makeEnv(kv, db),
      makeCtx(),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, matched: false });

    const duplicate = await app.fetch(
      await signedRequest("src-1", { event: { id: "deploy-1" } }, "source-secret"),
      makeEnv(kv, db),
      makeCtx(),
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ ok: true, deduped: true });
  });
});
