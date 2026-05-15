import { describe, expect, it } from "vitest";

import {
  normalizeGitHubIssueCommentEvent,
  normalizeGitHubIssuesEvent,
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

function issuePayload(action: string) {
  return {
    action,
    repository: { full_name: "acme/widgets" },
    issue: {
      number: 7,
      title: "Fix issue",
      body: "Issue details",
      state: action === "closed" ? "closed" : "open",
      labels: [{ name: "bug" }, { name: "agent" }],
      user: { login: "octocat" },
      assignees: [{ login: "hubot" }, { login: "monalisa" }],
    },
    label: { id: 99, name: "agent" },
    sender: { login: "octocat" },
  };
}

function issueCommentPayload(body = "/symphony help") {
  return {
    action: "created",
    repository: { full_name: "acme/widgets" },
    issue: {
      number: 7,
      title: "Fix issue",
      body: "Issue details",
      state: "open",
      labels: [{ name: "bug" }, { name: "agent" }],
      user: { login: "octocat" },
      assignees: [{ login: "hubot" }],
    },
    comment: { id: 123, body },
    sender: { login: "monalisa" },
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

describe("normalizeGitHubIssuesEvent", () => {
  it.each([
    ["opened", "github.issue.opened", "open"],
    ["labeled", "github.issue.labeled", "open"],
    ["closed", "github.issue.closed", "closed"],
  ] as const)("maps issues.%s to %s", (action, eventType, state) => {
    const mapped = normalizeGitHubIssuesEvent({
      payload: issuePayload(action),
      organizationId: "org-1",
      deliveryId: "delivery-issue-1",
    });

    expect(mapped?.event.event_type).toBe(eventType);
    expect(mapped?.event.subject).toMatchObject({
      kind: "github_issue",
      repo: "acme/widgets",
      number: 7,
      title: "Fix issue",
      body: "Issue details",
      state,
      labels: ["bug", "agent"],
      author: "octocat",
      assignees: ["hubot", "monalisa"],
    });
    expect(mapped?.event).toMatchObject({
      repo: "acme/widgets",
      author: "octocat",
      assignee_id: "hubot",
      labels: ["bug", "agent"],
    });
  });

  it("adds label_name for issues.labeled", () => {
    const mapped = normalizeGitHubIssuesEvent({
      payload: issuePayload("labeled"),
      organizationId: "org-1",
    });

    expect(mapped?.event).toMatchObject({
      event_type: "github.issue.labeled",
      label_name: "agent",
      label_id: "99",
    });
  });

  it("ignores unsupported issue actions and pull request issue payloads", () => {
    expect(
      normalizeGitHubIssuesEvent({
        payload: issuePayload("assigned"),
        organizationId: "org-1",
      }),
    ).toBeNull();

    expect(
      normalizeGitHubIssuesEvent({
        payload: {
          ...issuePayload("opened"),
          issue: { ...issuePayload("opened").issue, pull_request: {} },
        },
        organizationId: "org-1",
      }),
    ).toBeNull();
  });
});

describe("normalizeGitHubIssueCommentEvent", () => {
  it("maps issue_comment.created to github.issue.commented with comment body", () => {
    const mapped = normalizeGitHubIssueCommentEvent({
      payload: issueCommentPayload("/symphony help"),
      organizationId: "org-1",
      deliveryId: "delivery-comment-1",
    });

    expect(mapped?.event).toMatchObject({
      event_type: "github.issue.commented",
      repo: "acme/widgets",
      author: "octocat",
      assignee_id: "hubot",
      comment: "/symphony help",
      comment_id: "123",
    });
    expect(mapped?.event.subject).toMatchObject({
      kind: "github_issue",
      repo: "acme/widgets",
      number: 7,
      title: "Fix issue",
    });
  });

  it("ignores non-created issue_comment actions and PR comments", () => {
    expect(
      normalizeGitHubIssueCommentEvent({
        payload: { ...issueCommentPayload(), action: "edited" },
        organizationId: "org-1",
      }),
    ).toBeNull();
    expect(
      normalizeGitHubIssueCommentEvent({
        payload: {
          ...issueCommentPayload(),
          issue: { ...issueCommentPayload().issue, pull_request: {} },
        },
        organizationId: "org-1",
      }),
    ).toBeNull();
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
