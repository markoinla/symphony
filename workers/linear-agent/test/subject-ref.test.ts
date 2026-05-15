import { describe, expect, it } from "vitest";

import { EventTupleSchema, SubjectRefSchema } from "../src/schemas/event";

describe("SubjectRefSchema", () => {
  it("rejects linear_issue subjects without id", () => {
    const parsed = SubjectRefSchema.safeParse({
      kind: "linear_issue",
      identifier: "SYM-1",
      labels: [],
      comments: [],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects generic subjects with non-string external_id", () => {
    const parsed = SubjectRefSchema.safeParse({
      kind: "generic",
      external_id: 123,
      payload: {},
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts sentry_event subjects", () => {
    const parsed = SubjectRefSchema.safeParse({
      kind: "sentry_event",
      project: "backend",
      event_id: "evt-1",
      level: "error",
      fingerprint: ["TypeError"],
      message: "boom",
      stacktrace: [{ filename: "app.ts", function: "handler", lineno: 1, colno: 2, in_app: true, context_line: "throw err" }],
      breadcrumbs: [{ timestamp: "now", category: "http", level: "info", message: "GET /", data: { path: "/" } }],
      related_issue_url: "https://sentry.example/issues/1",
      environment: "production",
      release: "abc123",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts api.invoke events with generic subjects and context", () => {
    const parsed = EventTupleSchema.safeParse({
      event_type: "api.invoke",
      organization_id: "org-1",
      labels: [],
      subject: {
        kind: "generic",
        external_id: "nightly-build",
        payload: { branch: "main" },
      },
      context: { dry_run: false },
    });

    expect(parsed.success).toBe(true);
  });
});
