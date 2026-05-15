import { describe, expect, it } from "vitest";

import {
  buildSentryEventTuple,
  computeSentrySignature,
  normalizeSentryWebhook,
  verifySentrySignature,
} from "../src/lib/sentry";
import type { WebhookSourceRecord } from "../src/lib/store";

const source: WebhookSourceRecord = {
  id: "src-1",
  organization_id: "org-1",
  provider: "sentry",
  name: "Sentry",
  secret: "whsec_test",
  enabled: 1,
  project_id: "proj-1",
  config: JSON.stringify({ sentry_project: "backend" }),
  last_received_at: null,
  created_at: 1,
  updated_at: 1,
};

const eventPayload = {
  action: "event.alert",
  data: {
    event: {
      event_id: "evt-1",
      project: "backend",
      level: "error",
      fingerprint: ["TypeError", "checkout"],
      message: "Cannot read properties of undefined",
      environment: "production",
      release: "abc123",
      web_url: "https://sentry.example/events/evt-1",
      entries: [
        {
          type: "exception",
          data: {
            values: [
              {
                stacktrace: {
                  frames: [
                    {
                      filename: "src/checkout.ts",
                      function: "submit",
                      lineno: 42,
                      colno: 9,
                      in_app: true,
                      context_line: "cart.total.toFixed(2)",
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
      breadcrumbs: {
        values: [
          {
            timestamp: "2026-05-15T04:00:00Z",
            category: "ui.click",
            level: "info",
            message: "Clicked checkout",
            data: { button: "checkout" },
          },
        ],
      },
    },
    issue: { permalink: "https://sentry.example/issues/123" },
  },
};

describe("Sentry HMAC verifier", () => {
  it("accepts valid signatures and rejects missing/tampered payloads", async () => {
    const raw = JSON.stringify(eventPayload);
    const sig = await computeSentrySignature(source.secret, raw);

    await expect(verifySentrySignature(source.secret, raw, sig)).resolves.toBe(true);
    await expect(verifySentrySignature(source.secret, raw + "x", sig)).resolves.toBe(false);
    await expect(verifySentrySignature(source.secret, raw, null)).resolves.toBe(false);
  });
});

describe("Sentry normalizer", () => {
  it("normalizes event.alert with stacktrace and breadcrumbs", () => {
    const normalized = normalizeSentryWebhook(eventPayload, source);
    expect(normalized.eventType).toBe("sentry.alert.fired");
    expect(normalized.subject).toMatchObject({
      kind: "sentry_event",
      project: "backend",
      event_id: "evt-1",
      level: "error",
      fingerprint: ["TypeError", "checkout"],
      environment: "production",
      release: "abc123",
      related_issue_url: "https://sentry.example/issues/123",
    });
    expect(normalized.subject.stacktrace[0]).toMatchObject({
      filename: "src/checkout.ts",
      function: "submit",
      lineno: 42,
      in_app: true,
    });
    expect(normalized.subject.breadcrumbs[0]).toMatchObject({
      category: "ui.click",
      message: "Clicked checkout",
      data: { button: "checkout" },
    });
  });

  it("normalizes issue.created and builds an EventTuple with match fields", () => {
    const payload = {
      action: "issue.created",
      data: {
        issue: {
          id: "iss-1",
          title: "New issue",
          project: "api",
          level: "warning",
          fingerprint: ["group-1"],
          permalink: "https://sentry.example/issues/iss-1",
        },
      },
    };
    const normalized = normalizeSentryWebhook(payload, source);
    const event = buildSentryEventTuple({ orgId: "org-1", source, normalized });
    expect(event.event_type).toBe("sentry.issue.created");
    expect(event.project_id).toBe("proj-1");
    expect((event as any).sentry_level).toBe("warning");
    expect((event as any).sentry_project).toBe("api");
    expect((event as any).sentry_fingerprint).toEqual(["group-1"]);
  });
});
