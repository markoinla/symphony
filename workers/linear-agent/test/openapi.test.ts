// Smoke test for /openapi.json — guards against regressions where a
// route is added to api-v1.ts but not the OpenAPI doc, and confirms
// the Zod schemas serialize cleanly.

import { describe, expect, it } from "vitest";

import { buildApp, type Env } from "../src/index";

function makeEnv(): Env {
  return {
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    LINEAR_TOKENS: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace,
    SESSION_RUNNER: {} as unknown as Workflow,
    DB: {} as unknown as D1Database,
    LINEAR_CLIENT_ID: "x",
    LINEAR_CLIENT_SECRET: "x",
    LINEAR_WEBHOOK_SECRET: "x",
    DISPATCHER_URL: "https://dispatcher.example",
    DISPATCH_HMAC_SECRET: "x",
    URL: "https://agent.example",
    DEFAULT_SCOPE: "x",
    DEFAULT_MODEL: "x",
    DEFAULT_ENGINE: "pi",
  };
}

function makeExecCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

const EXPECTED_PATHS = [
  "/api/v1/workflows",
  "/api/v1/workflows/{id}",
  "/api/v1/workflows/{id}/publish",
  "/api/v1/workflows/{id}/duplicate",
  "/api/v1/workflows/{id}/preview",
  "/api/v1/workflows/{id}/triggers",
  "/api/v1/triggers/{id}",
  "/api/v1/projects",
  "/api/v1/projects/{id}",
  "/api/v1/settings",
  "/api/v1/settings/{key}",
  "/api/v1/integrations",
  "/api/v1/api-tokens",
  "/api/v1/api-tokens/{id}",
  "/api/v1/webhook-events",
  "/api/v1/webhook-events/{id}",
];

describe("/openapi.json", () => {
  it("serves an OpenAPI 3.1 document with every v1 path", async () => {
    const res = await buildApp().fetch(
      new Request("https://agent.example/openapi.json"),
      makeEnv(),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toContain("linear-agent");
    for (const path of EXPECTED_PATHS) {
      expect(doc.paths).toHaveProperty(path);
    }
    // Schemas wired through z.toJSONSchema must all be present.
    const expectedSchemas = [
      "Workflow", "WorkflowCreateInput", "WorkflowUpdateInput",
      "Trigger", "TriggerCreateInput", "TriggerUpdateInput",
      "Project", "ProjectCreateInput", "ProjectUpdateInput",
      "ApiToken", "ApiTokenCreateInput",
      "Setting", "Integrations", "WebhookEvent",
      "ErrorEnvelope",
    ];
    for (const name of expectedSchemas) {
      expect(doc.components.schemas).toHaveProperty(name);
    }
    expect(doc.components.securitySchemes).toHaveProperty("bearer");
    expect(doc.components.securitySchemes).toHaveProperty("cookie");
  });
});
