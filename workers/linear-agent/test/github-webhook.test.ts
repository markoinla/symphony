import { describe, expect, it } from "vitest";

import {
  normalizeGitHubPullRequestEvent,
  verifyGitHubSignature,
} from "../src/lib/github-webhook";
import { computeLinearSignature } from "../src/lib/signature";

function payload(action: string, merged = false) {
  return {
    action,
    repository: { full_name: "acme/widgets" },
    pull_request: {
      number: 42,
      title: "Add widget",
      body: "Details",
      state: merged || action === "closed" ? "closed" : "open",
      merged,
      base: { ref: "main" },
      head: { ref: "feature/widget", sha: "abc123" },
      draft: false,
      labels: [{ name: "ready" }, { name: "agent" }],
      user: { login: "octocat" },
      requested_reviewers: [{ login: "hubot" }],
    },
    sender: { login: "octocat" },
  };
}

describe("verifyGitHubSignature", () => {
  it("accepts valid sha256 signatures", async () => {
    const body = JSON.stringify({ ok: true });
    const sig = `sha256=${await computeLinearSignature("secret", body)}`;
    await expect(verifyGitHubSignature("secret", body, sig)).resolves.toBe(true);
  });

  it("rejects tampered payloads", async () => {
    const sig = `sha256=${await computeLinearSignature("secret", "original")}`;
    await expect(verifyGitHubSignature("secret", "tampered", sig)).resolves.toBe(false);
  });

  it("rejects missing signature headers", async () => {
    await expect(verifyGitHubSignature("secret", "body", null)).resolves.toBe(false);
  });
});

describe("normalizeGitHubPullRequestEvent", () => {
  it.each([
    ["opened", false, "github.pr.opened", "open"],
    ["closed", false, "github.pr.closed", "closed"],
    ["closed", true, "github.pr.merged", "merged"],
    ["review_requested", false, "github.pr.review_requested", "open"],
  ] as const)("maps pull_request.%s to %s", (action, merged, eventType, state) => {
    const mapped = normalizeGitHubPullRequestEvent({
      payload: payload(action, merged),
      organizationId: "org-1",
      deliveryId: "delivery-1",
    });

    expect(mapped?.event.event_type).toBe(eventType);
    expect(mapped?.event.subject).toMatchObject({
      kind: "github_pr",
      repo: "acme/widgets",
      number: 42,
      title: "Add widget",
      body: "Details",
      state,
      base: "main",
      head: "feature/widget",
      draft: false,
      labels: ["ready", "agent"],
      author: "octocat",
      reviewers: ["hubot"],
      head_sha: "abc123",
    });
  });

  it("ignores unsupported pull_request actions", () => {
    expect(
      normalizeGitHubPullRequestEvent({
        payload: payload("synchronize"),
        organizationId: "org-1",
      }),
    ).toBeNull();
  });
});
