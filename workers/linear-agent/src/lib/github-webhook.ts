import { computeLinearSignature } from "./signature";
import type { EventTuple } from "../schemas/event";

export type GitHubPrAction = "opened" | "closed" | "review_requested";

export interface GitHubPullRequestPayload {
  action?: string;
  repository?: {
    full_name?: string;
  };
  pull_request?: {
    number?: number;
    title?: string | null;
    body?: string | null;
    state?: string | null;
    merged?: boolean | null;
    base?: { ref?: string | null } | null;
    head?: { ref?: string | null; sha?: string | null } | null;
    draft?: boolean | null;
    labels?: Array<{ name?: string | null }> | null;
    user?: { login?: string | null } | null;
    requested_reviewers?: Array<{ login?: string | null }> | null;
  };
  organization?: { id?: number | string | null; login?: string | null } | null;
  installation?: { id?: number | null } | null;
  sender?: { login?: string | null } | null;
}

export interface GitHubNormalizeResult {
  event: EventTuple;
  summary: string;
  externalDeliveryId: string | null;
}

export async function verifyGitHubSignature(
  secret: string,
  body: string | Uint8Array,
  provided: string | null | undefined,
): Promise<boolean> {
  if (!provided?.startsWith("sha256=")) return false;
  const hex = await computeLinearSignature(secret, body);
  return constantTimeEqual(`sha256=${hex}`, provided);
}

export function normalizeGitHubPullRequestEvent(args: {
  payload: GitHubPullRequestPayload;
  organizationId: string;
  deliveryId?: string | null;
}): GitHubNormalizeResult | null {
  const { payload, organizationId, deliveryId = null } = args;
  if (!payload || payload.action == null) return null;
  if (!isSupportedAction(payload.action)) return null;

  const pr = payload.pull_request;
  const repo = payload.repository?.full_name;
  const number = pr?.number;
  if (!pr || !repo || typeof number !== "number") return null;

  const state = pr.merged === true ? "merged" : pr.state === "closed" ? "closed" : "open";
  const labels = (pr.labels ?? [])
    .map((l) => l.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  const reviewers = (pr.requested_reviewers ?? [])
    .map((r) => r.login)
    .filter((login): login is string => typeof login === "string" && login.length > 0);

  const subject = {
    kind: "github_pr" as const,
    repo,
    number,
    title: pr.title ?? "",
    body: pr.body ?? "",
    state,
    base: pr.base?.ref ?? "",
    head: pr.head?.ref ?? "",
    draft: pr.draft ?? false,
    labels,
    author: pr.user?.login ?? "",
    reviewers,
    head_sha: pr.head?.sha ?? "",
  };

  const eventType =
    payload.action === "review_requested"
      ? "github.pr.review_requested"
      : state === "merged"
        ? "github.pr.merged"
        : state === "closed"
          ? "github.pr.closed"
          : "github.pr.opened";

  const event: EventTuple = {
    event_type: eventType,
    organization_id: organizationId,
    team_id: null,
    project_id: null,
    user_id: null,
    assignee_id: null,
    labels,
    subject,
    issue: null,
    actor_id: payload.sender?.login ?? null,
    repo,
    branch: subject.head,
    base: subject.base,
    draft: subject.draft,
    author: subject.author,
  } as EventTuple;

  return {
    event,
    summary: `${repo}#${number} ${eventType}`,
    externalDeliveryId: deliveryId,
  };
}

function isSupportedAction(action: string): action is GitHubPrAction {
  return action === "opened" || action === "closed" || action === "review_requested";
}

function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}
