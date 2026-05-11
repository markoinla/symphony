// Normalize a raw Linear webhook delivery into one or more
// `EventTuple`s the resolver can match against. Linear sends a wide
// variety of payload shapes — this is the single place that knows
// about them.
//
// Returns `null` (rather than `[]`) when the payload type isn't
// something we route on, so callers can distinguish "ignore" from
// "no match" and fall through to legacy handling for AgentSessionEvent
// retries.

import type { EventTuple, IssueRef } from "../../schemas/event";

// Shape of fields we touch on the raw webhook body. Kept loose because
// Linear's payloads vary by event type and version; everything is
// optional and the normalizer narrows defensively.
export interface LinearWebhookBody {
  type?: string;
  action?: string;
  organizationId?: string;
  // Top-level actor (the user that triggered the change) — Linear
  // sometimes provides it on Issue/Comment updates.
  actor?: { id?: string } | null;
  data?: LinearWebhookData;
  updatedFrom?: LinearUpdatedFrom;
  // AgentSessionEvent envelope (existing flow); normalized into a
  // `session_started` tuple so the resolver can route on it.
  agentSession?: {
    id?: string;
    issue?: LinearWebhookIssue;
  };
}

interface LinearWebhookData {
  id?: string;
  identifier?: string;
  title?: string;
  state?: { id?: string; name?: string } | null;
  stateId?: string;
  team?: { id?: string; key?: string } | null;
  teamId?: string;
  project?: { id?: string } | null;
  projectId?: string;
  assignee?: { id?: string } | null;
  assigneeId?: string | null;
  labels?: Array<{ id?: string; name?: string }>;
  labelIds?: string[];
  // For Comment events
  body?: string;
  user?: { id?: string } | null;
  userId?: string;
  issue?: LinearWebhookIssue;
  issueId?: string;
  // For IssueLabel events
  label?: { id?: string; name?: string };
  // Linear sometimes nests an `updatedFrom` on the entity instead of
  // the envelope.
  updatedFrom?: LinearUpdatedFrom;
}

interface LinearUpdatedFrom {
  stateId?: string;
  assigneeId?: string | null;
  labelIds?: string[];
}

interface LinearWebhookIssue {
  id?: string;
  identifier?: string;
  title?: string;
  teamId?: string;
  team?: { id?: string; key?: string };
  state?: { id?: string; name?: string };
  stateId?: string;
  projectId?: string;
  assigneeId?: string | null;
  labels?: Array<{ id?: string; name?: string }>;
}

/**
 * Normalize a raw Linear webhook into 0+ `EventTuple`s.
 *
 * The Linear "Issue update" payload often carries several semantic
 * changes at once (a state move + an assignee change, say). We emit
 * one tuple per change so the resolver gets a clean per-event match.
 *
 * Returns `null` when the envelope isn't routable — callers can fall
 * through to legacy handling.
 */
export function normalize(body: LinearWebhookBody): EventTuple[] | null {
  if (!body || typeof body !== "object") return null;

  const orgId = body.organizationId ?? body.data?.team?.id;
  if (!orgId) return null;

  switch (body.type) {
    case "Issue":
      return normalizeIssue(body, orgId);
    case "Comment":
      return normalizeComment(body, orgId);
    case "IssueLabel":
      return normalizeIssueLabel(body, orgId);
    case "AgentSessionEvent":
      return normalizeAgentSession(body, orgId);
    default:
      return null;
  }
}

function normalizeIssue(
  body: LinearWebhookBody,
  organizationId: string,
): EventTuple[] | null {
  const data = body.data;
  if (!data || !data.id) return null;

  const issueRef = buildIssueRef(data);
  const updatedFrom = body.updatedFrom ?? data.updatedFrom;

  const out: EventTuple[] = [];
  const base = {
    organization_id: organizationId,
    team_id: data.teamId ?? data.team?.id ?? issueRef?.team_id ?? null,
    project_id: data.projectId ?? data.project?.id ?? issueRef?.project_id ?? null,
    user_id: body.actor?.id ?? null,
    assignee_id: data.assigneeId ?? data.assignee?.id ?? issueRef?.assignee_id ?? null,
    labels: issueRef?.labels ?? [],
    issue: issueRef,
    actor_id: body.actor?.id ?? null,
  };

  // State transition — emit both state_entered AND state_exited so
  // workflows can listen for either side of the move.
  if (updatedFrom?.stateId && data.stateId && updatedFrom.stateId !== data.stateId) {
    const toState = data.state?.name ?? null;
    // We don't have the previous state's name in `updatedFrom` (Linear
    // only ships the id). The resolver matches `from_state` by name,
    // so triggers that filter on it won't fire here unless the seed
    // /UI is updated to use ids. That's acceptable for the seeded
    // example triggers, which only filter on `to_state`.
    const fromState = null;
    if (toState) {
      out.push({
        event_type: "state_entered",
        ...base,
        to_state: toState,
        from_state: fromState,
      });
    }
    if (fromState || toState) {
      out.push({
        event_type: "state_exited",
        ...base,
        from_state: fromState ?? "",
        to_state: toState,
      } as EventTuple);
    }
  }

  if (
    updatedFrom &&
    Object.prototype.hasOwnProperty.call(updatedFrom, "assigneeId") &&
    (updatedFrom.assigneeId ?? null) !== (data.assigneeId ?? data.assignee?.id ?? null)
  ) {
    out.push({
      event_type: "assignee_changed",
      ...base,
      to_assignee_id: data.assigneeId ?? data.assignee?.id ?? null,
      from_assignee_id: updatedFrom.assigneeId ?? null,
    });
  }

  if (updatedFrom?.labelIds && Array.isArray(updatedFrom.labelIds)) {
    const prev = new Set(updatedFrom.labelIds);
    const curr = new Set(
      (data.labels ?? []).map((l) => l.id).filter((id): id is string => !!id),
    );
    const currNames = new Map(
      (data.labels ?? [])
        .filter((l): l is { id: string; name: string } => !!l.id && !!l.name)
        .map((l) => [l.id, l.name] as const),
    );

    for (const id of curr) {
      if (!prev.has(id)) {
        out.push({
          event_type: "label_added",
          ...base,
          label_id: id,
          label_name: currNames.get(id) ?? "",
        });
      }
    }
    for (const id of prev) {
      if (!curr.has(id)) {
        out.push({
          event_type: "label_removed",
          ...base,
          label_id: id,
          // We don't know the removed label's name without a lookup.
          label_name: "",
        });
      }
    }
  }

  return out.length > 0 ? out : null;
}

function normalizeComment(
  body: LinearWebhookBody,
  organizationId: string,
): EventTuple[] | null {
  const data = body.data;
  if (!data || body.action !== "create") return null;
  const commentBody = typeof data.body === "string" ? data.body : "";
  const issueRef = data.issue ? buildIssueRef(data.issue) : null;

  return [
    {
      event_type: "comment_added",
      organization_id: organizationId,
      team_id: issueRef?.team_id ?? null,
      project_id: issueRef?.project_id ?? null,
      user_id: data.userId ?? data.user?.id ?? body.actor?.id ?? null,
      assignee_id: issueRef?.assignee_id ?? null,
      labels: issueRef?.labels ?? [],
      issue: issueRef,
      actor_id: data.userId ?? data.user?.id ?? body.actor?.id ?? null,
      comment: commentBody,
      comment_id: data.id ?? null,
    },
  ];
}

function normalizeIssueLabel(
  body: LinearWebhookBody,
  organizationId: string,
): EventTuple[] | null {
  const data = body.data;
  if (!data || body.action !== "create") return null;
  const issueRef = data.issue ? buildIssueRef(data.issue) : null;

  return [
    {
      event_type: "label_added",
      organization_id: organizationId,
      team_id: issueRef?.team_id ?? null,
      project_id: issueRef?.project_id ?? null,
      user_id: body.actor?.id ?? null,
      assignee_id: issueRef?.assignee_id ?? null,
      labels: issueRef?.labels ?? [],
      issue: issueRef,
      actor_id: body.actor?.id ?? null,
      label_id: data.label?.id ?? data.id ?? null,
      label_name: data.label?.name ?? "",
    },
  ];
}

function normalizeAgentSession(
  body: LinearWebhookBody,
  organizationId: string,
): EventTuple[] | null {
  const session = body.agentSession;
  if (!session) return null;
  const issueRef = session.issue ? buildIssueRef(session.issue) : null;

  return [
    {
      event_type: "session_started",
      organization_id: organizationId,
      team_id: issueRef?.team_id ?? null,
      project_id: issueRef?.project_id ?? null,
      user_id: body.actor?.id ?? null,
      assignee_id: issueRef?.assignee_id ?? null,
      labels: issueRef?.labels ?? [],
      issue: issueRef,
      actor_id: body.actor?.id ?? null,
      agent_session_id: session.id ?? null,
    },
  ];
}

function buildIssueRef(
  data: LinearWebhookData | LinearWebhookIssue,
): IssueRef | null {
  if (!data.id) return null;
  const labels =
    (data.labels ?? [])
      .map((l) => l.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  return {
    id: data.id,
    identifier: data.identifier ?? null,
    title: data.title ?? null,
    state: data.state?.name ?? null,
    state_id: data.state?.id ?? data.stateId ?? null,
    team_id: data.teamId ?? data.team?.id ?? null,
    project_id:
      (data as LinearWebhookData).projectId ??
      (data as LinearWebhookData).project?.id ??
      (data as LinearWebhookIssue).projectId ??
      null,
    assignee_id:
      (data as LinearWebhookData).assigneeId ??
      (data as LinearWebhookData).assignee?.id ??
      (data as LinearWebhookIssue).assigneeId ??
      null,
    labels,
    parent_issue: null,
    comments: [],
  };
}
