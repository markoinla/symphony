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

  it("accepts github_issue subjects with canonical issue fields", () => {
    const parsed = SubjectRefSchema.safeParse({
      kind: "github_issue",
      repo: "acme/widgets",
      number: 12,
      title: "Bug report",
      body: "broken",
      state: "open",
      labels: ["bug"],
      author: "octocat",
      assignees: ["hubot"],
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
