/**
 * Map a Linear `Issue` webhook envelope to a normalized `EventTuple`
 * the resolver consumes. Today only the `state_entered` event_type
 * is emitted — other variants (label_added, comment_added, …) land
 * incrementally as their dedicated branches are wired into the
 * webhook handler.
 *
 * Linear's update webhook carries the *new* state inside `data.state`
 * and the *previous* `stateId` inside `updatedFrom.stateId`. The
 * resolver matches `to_state` against whatever value the user typed
 * into their trigger config — that's the state *name* in the
 * dashboard, so we surface `data.state.name`, not the id.
 *
 * The mapper is pure: callers do tenant resolution + webhook log
 * inserts themselves and pass the result in via `orgId`.
 */

import type { EventTuple } from "../schemas/event";

export interface IssueWebhookEnvelope {
  type: "Issue";
  action: "create" | "update" | "remove";
  data?: IssueWebhookData;
  updatedFrom?: Record<string, unknown> | null;
  organizationId?: string;
  webhookId?: string;
  // Per-delivery timestamp Linear stamps on every webhook payload.
  // Retries of the same delivery carry the same value; distinct events
  // (including re-entries into the same state) carry different ones.
  // Used in the issue-envelope dedup key to keep retries collapsed
  // while still letting real re-transitions through.
  webhookTimestamp?: number;
}

export interface IssueWebhookData {
  id: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  stateId?: string | null;
  teamId?: string | null;
  projectId?: string | null;
  assigneeId?: string | null;
  state?: { id?: string; name?: string } | null;
  team?: { id?: string; key?: string; name?: string } | null;
  project?: { id?: string; name?: string } | null;
  assignee?: { id?: string; name?: string } | null;
  labels?: Array<{ id?: string; name?: string }>;
}

export interface MapResult {
  event: EventTuple;
  /** Human-readable label for the webhook log row. */
  summary: string;
  /** Previous state name, if we can derive it from `updatedFrom`. */
  fromStateName: string | null;
}

/**
 * Map an `Issue` envelope to a `state_entered` event. Returns null
 * when:
 *   - action is not "create" or "update"
 *   - data.state is missing
 *   - action="update" but updatedFrom.stateId is missing or unchanged
 *     (no state transition happened)
 *
 * `Issue.create` is treated as a state_entered with `from_state: null`
 * — semantically "issue was born in this state." Without this, a
 * trigger like `to_state=Staged` would only fire when an issue is
 * moved into Staged from another state, never when it's created
 * directly in Staged. That's surprising for non-Backlog defaults.
 *
 * The webhook log layer still records the row — the null just signals
 * "no trigger to evaluate for this delivery."
 */
export function mapIssueUpdateToEvent(
  envelope: IssueWebhookEnvelope,
  orgId: string,
): MapResult | null {
  if (envelope.action !== "update" && envelope.action !== "create") return null;
  const data = envelope.data;
  if (!data) return null;

  const newStateId = data.stateId ?? data.state?.id ?? null;
  if (!newStateId) return null;

  let prevStateId: string | null = null;
  let fromStateName: string | null = null;

  if (envelope.action === "update") {
    const updatedFrom = (envelope.updatedFrom ?? {}) as Record<string, unknown>;
    prevStateId =
      typeof updatedFrom.stateId === "string" ? updatedFrom.stateId : null;
    if (!prevStateId || prevStateId === newStateId) {
      // Update without a state transition (e.g., title/desc edit).
      return null;
    }
    // updatedFrom may carry a `state` shallow object too (Linear is
    // inconsistent), but it most reliably only ships the scalar id.
    fromStateName =
      typeof (updatedFrom as { state?: { name?: string } }).state?.name ===
      "string"
        ? ((updatedFrom as { state?: { name?: string } }).state!.name as string)
        : null;
  }
  // `create`: leave prevStateId/fromStateName null — the issue had
  // no prior state.

  const toStateName = data.state?.name ?? newStateId;

  const labels = (data.labels ?? [])
    .map((l) => l.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);

  const identifier = data.identifier ?? data.id;
  const summary = fromStateName
    ? `${identifier} ${fromStateName} → ${toStateName}`
    : `${identifier} → ${toStateName}`;

  const event: EventTuple = {
    event_type: "state_entered",
    organization_id: orgId,
    team_id: data.teamId ?? data.team?.id ?? null,
    project_id: data.projectId ?? data.project?.id ?? null,
    assignee_id: data.assigneeId ?? data.assignee?.id ?? null,
    labels,
    issue: {
      id: data.id,
      identifier: data.identifier ?? null,
      title: data.title ?? null,
      description: data.description ?? null,
      state: toStateName,
      state_id: newStateId,
      team_id: data.teamId ?? data.team?.id ?? null,
      project_id: data.projectId ?? data.project?.id ?? null,
      assignee_id: data.assigneeId ?? data.assignee?.id ?? null,
      labels,
      comments: [],
    },
    to_state: toStateName,
    from_state: fromStateName,
  };

  return { event, summary, fromStateName };
}

/** Cheap discriminator for the webhook router. */
export function isIssueEnvelope(value: unknown): value is IssueWebhookEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "Issue" && typeof v.action === "string";
}
