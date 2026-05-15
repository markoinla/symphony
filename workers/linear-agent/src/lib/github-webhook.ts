import { computeLinearSignature } from "./signature";
import type { EventTuple } from "../schemas/event";

export type GitHubPrAction = "opened" | "closed" | "review_requested";
export type GitHubIssueAction = "opened" | "closed" | "labeled";
export type GitHubIssueCommentAction = "created";

interface GitHubUserRef {
  login?: string | null;
}

interface GitHubLabelRef {
  id?: number | string | null;
  name?: string | null;
}

interface GitHubIssueRef {
  number?: number;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  html_url?: string | null;
  labels?: GitHubLabelRef[] | null;
  user?: GitHubUserRef | null;
  assignees?: GitHubUserRef[] | null;
  pull_request?: unknown;
}

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
    labels?: GitHubLabelRef[] | null;
    user?: GitHubUserRef | null;
    requested_reviewers?: GitHubUserRef[] | null;
  };
  organization?: { id?: number | string | null; login?: string | null } | null;
  installation?: { id?: number | null } | null;
  sender?: { login?: string | null } | null;
}

export interface GitHubIssuesPayload {
  action?: string;
  repository?: {
    full_name?: string;
  };
  issue?: GitHubIssueRef | null;
  label?: GitHubLabelRef | null;
  organization?: { id?: number | string | null; login?: string | null } | null;
  installation?: { id?: number | null } | null;
  sender?: GitHubUserRef | null;
}

export interface GitHubIssueCommentPayload {
  action?: string;
  repository?: {
    full_name?: string;
  };
  issue?: GitHubIssueRef | null;
  comment?: { id?: number | string | null; body?: string | null } | null;
  organization?: { id?: number | string | null; login?: string | null } | null;
  installation?: { id?: number | null } | null;
  sender?: GitHubUserRef | null;
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

export function normalizeGitHubIssuesEvent(args: {
  payload: GitHubIssuesPayload;
  organizationId: string;
  deliveryId?: string | null;
}): GitHubNormalizeResult | null {
  const { payload, organizationId, deliveryId = null } = args;
  if (!payload || payload.action == null) return null;
  if (!isSupportedIssueAction(payload.action)) return null;

  const issue = payload.issue;
  const repo = payload.repository?.full_name;
  const number = issue?.number;
  if (!issue || issue.pull_request != null || !repo || typeof number !== "number") return null;

  const subject = buildIssueSubject(repo, issue);
  const labels = subject.labels;
  const assignees = subject.assignees;
  const labelName = payload.label?.name ?? null;
  const labelId = payload.label?.id == null ? null : String(payload.label.id);
  const eventType = `github.issue.${payload.action}` as
    | "github.issue.opened"
    | "github.issue.labeled"
    | "github.issue.closed";

  const event: EventTuple = {
    event_type: eventType,
    organization_id: organizationId,
    team_id: null,
    project_id: null,
    user_id: null,
    assignee_id: assignees[0] ?? null,
    labels,
    subject,
    issue: null,
    actor_id: payload.sender?.login ?? null,
    repo,
    author: subject.author,
    ...(payload.action === "labeled"
      ? { label_name: labelName ?? "", label_id: labelId }
      : {}),
  } as EventTuple;

  return {
    event,
    summary: `${repo}#${number} ${eventType}`,
    externalDeliveryId: deliveryId,
  };
}

export function normalizeGitHubIssueCommentEvent(args: {
  payload: GitHubIssueCommentPayload;
  organizationId: string;
  deliveryId?: string | null;
}): GitHubNormalizeResult | null {
  const { payload, organizationId, deliveryId = null } = args;
  if (!payload || payload.action == null) return null;
  if (!isSupportedIssueCommentAction(payload.action)) return null;

  const issue = payload.issue;
  const repo = payload.repository?.full_name;
  const number = issue?.number;
  if (!issue || issue.pull_request != null || !repo || typeof number !== "number") return null;

  const subject = buildIssueSubject(repo, issue);
  const labels = subject.labels;
  const assignees = subject.assignees;
  const commentId = payload.comment?.id == null ? null : String(payload.comment.id);
  const event: EventTuple = {
    event_type: "github.issue.commented",
    organization_id: organizationId,
    team_id: null,
    project_id: null,
    user_id: null,
    assignee_id: assignees[0] ?? null,
    labels,
    subject,
    issue: null,
    actor_id: payload.sender?.login ?? null,
    repo,
    author: subject.author,
    comment: payload.comment?.body ?? "",
    comment_id: commentId,
  } as EventTuple;

  return {
    event,
    summary: `${repo}#${number} github.issue.commented`,
    externalDeliveryId: deliveryId,
  };
}

function buildIssueSubject(repo: string, issue: GitHubIssueRef) {
  const labels = (issue.labels ?? [])
    .map((l) => l.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  const assignees = (issue.assignees ?? [])
    .map((a) => a.login)
    .filter((login): login is string => typeof login === "string" && login.length > 0);

  return {
    kind: "github_issue" as const,
    repo,
    number: issue.number ?? 0,
    title: issue.title ?? "",
    body: issue.body ?? "",
    state: issue.state === "closed" ? "closed" as const : "open" as const,
    labels,
    author: issue.user?.login ?? "",
    assignees,
  };
}

function isSupportedAction(action: string): action is GitHubPrAction {
  return action === "opened" || action === "closed" || action === "review_requested";
}

function isSupportedIssueAction(action: string): action is GitHubIssueAction {
  return action === "opened" || action === "closed" || action === "labeled";
}

function isSupportedIssueCommentAction(action: string): action is GitHubIssueCommentAction {
  return action === "created";
}

function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}
