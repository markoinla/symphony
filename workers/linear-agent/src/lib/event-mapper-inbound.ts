/**
 * Map a Linear `Issue` webhook envelope to one or more normalized
 * `EventTuple`s the resolver consumes.
 *
 * One Linear delivery can describe several distinct events: a state
 * change ships state_entered + state_exited; a label edit emits
 * label_added per *added* label (removals are intentionally not
 * surfaced — see below); an assignee change emits assignee_changed.
 *
 * What Linear sends in the `Issue.update` payload:
 *
 *   - `data` carries the *new* values: `state`, `stateId`, `labels`
 *     (`[{id, name}]`), `assigneeId`.
 *   - `updatedFrom` carries the *previous* values for fields that
 *     actually changed: `stateId`, `assigneeId`, `labelIds` (an
 *     array of label ids). Fields not in `updatedFrom` are unchanged.
 *
 * The resolver matches `to_state`/`label_name` against the user-typed
 * trigger config (state *name*, label *name*), so we surface names
 * rather than ids on the emitted events.
 *
 * Not handled here:
 *
 *   - `label_removed` — Linear's webhook ships only the *prior* label
 *     ids, not the prior names, so a name-keyed trigger can't match
 *     reliably. We dropped the event_type from the trigger system
 *     rather than ship a half-working surface.
 *   - `comment_added` — Comments arrive as a separate envelope
 *     (`type: "Comment"`) and need an inline Linear GraphQL fetch to
 *     fill in the issue context the dispatcher requires. We chose not
 *     to pay that inside the 5s webhook SLA window.
 *
 * The mapper is pure: callers do tenant resolution + webhook log
 * inserts themselves and pass the resolved orgId in.
 */

import type { EventTuple } from "../schemas/event";

export interface IssueWebhookEnvelope {
  type: "Issue";
  action: "create" | "update" | "remove";
  data?: IssueWebhookData;
  updatedFrom?: IssueUpdatedFrom | null;
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
  labelIds?: string[];
}

// `updatedFrom` only carries fields that actually changed. Linear's
// shape isn't fully pinned in their docs, but in practice we see
// `stateId`, `assigneeId`, and `labelIds` for the cases we care about.
// `Record<string, unknown>` keeps the door open for future fields
// without forcing a schema bump.
export interface IssueUpdatedFrom {
  stateId?: string | null;
  state?: { id?: string; name?: string } | null;
  assigneeId?: string | null;
  labelIds?: string[];
  [key: string]: unknown;
}

export interface MapResult {
  event: EventTuple;
  /** Human-readable label for the webhook log row. */
  summary: string;
}

/**
 * Map an `Issue` envelope to the full set of normalized events it
 * describes. Returns an empty array when the envelope carries no
 * event we care about (e.g. a `remove`, or an `update` that only
 * touched fields we don't model).
 *
 * `Issue.create` is treated as a single state_entered with
 * `from_state: null` — semantically "issue was born in this state."
 * Without this, a trigger like `to_state=Staged` would only fire when
 * an issue is moved into Staged from another state, never when it's
 * created directly in Staged.
 */
export function mapIssueEnvelopeToEvents(
  envelope: IssueWebhookEnvelope,
  orgId: string,
): MapResult[] {
  if (envelope.action !== "update" && envelope.action !== "create") return [];
  const data = envelope.data;
  if (!data) return [];

  const updatedFrom = envelope.updatedFrom ?? null;
  const baseScope = buildBaseScope(data, orgId);
  const issueRef = buildIssueRef(data);
  const identifier = data.identifier ?? data.id;

  const results: MapResult[] = [];

  // ── state transitions ──────────────────────────────────────────
  const newStateId = data.stateId ?? data.state?.id ?? null;
  const toStateName = data.state?.name ?? newStateId;

  if (envelope.action === "create" && newStateId && toStateName) {
    results.push({
      event: {
        ...baseScope,
        event_type: "state_entered",
        issue: issueRef,
        to_state: toStateName,
        from_state: null,
      },
      summary: `${identifier} → ${toStateName}`,
    });
  }

  if (envelope.action === "update" && updatedFrom && "stateId" in updatedFrom) {
    const prevStateId =
      typeof updatedFrom.stateId === "string" ? updatedFrom.stateId : null;
    if (prevStateId && newStateId && prevStateId !== newStateId && toStateName) {
      const fromStateName =
        typeof updatedFrom.state?.name === "string"
          ? updatedFrom.state.name
          : null;
      // Emit state_exited first so any cleanup trigger on the old
      // state fires before the entering trigger on the new state.
      // The resolver still picks one (workflow, trigger) per event,
      // so this only matters when both are configured.
      if (fromStateName) {
        results.push({
          event: {
            ...baseScope,
            event_type: "state_exited",
            issue: issueRef,
            from_state: fromStateName,
            to_state: toStateName,
          },
          summary: `${identifier} ${fromStateName} → (exited)`,
        });
      }
      results.push({
        event: {
          ...baseScope,
          event_type: "state_entered",
          issue: issueRef,
          to_state: toStateName,
          from_state: fromStateName,
        },
        summary: fromStateName
          ? `${identifier} ${fromStateName} → ${toStateName}`
          : `${identifier} → ${toStateName}`,
      });
    }
  }

  // ── label additions ────────────────────────────────────────────
  // Only emit label_added — see the file-level comment for why
  // label_removed isn't surfaced.
  if (envelope.action === "update" && updatedFrom && "labelIds" in updatedFrom) {
    const prevLabelIds = Array.isArray(updatedFrom.labelIds)
      ? updatedFrom.labelIds.filter((id): id is string => typeof id === "string")
      : [];
    const prevIds = new Set(prevLabelIds);
    for (const l of data.labels ?? []) {
      const id = typeof l.id === "string" ? l.id : null;
      const name = typeof l.name === "string" ? l.name : null;
      if (!id || !name) continue;
      if (prevIds.has(id)) continue;
      results.push({
        event: {
          ...baseScope,
          event_type: "label_added",
          issue: issueRef,
          label_name: name,
          label_id: id,
        },
        summary: `${identifier} +label ${name}`,
      });
    }
  }

  // ── assignee change ────────────────────────────────────────────
  if (envelope.action === "update" && updatedFrom && "assigneeId" in updatedFrom) {
    const fromAssigneeId =
      typeof updatedFrom.assigneeId === "string" ? updatedFrom.assigneeId : null;
    const toAssigneeId =
      typeof data.assigneeId === "string"
        ? data.assigneeId
        : typeof data.assignee?.id === "string"
          ? data.assignee.id
          : null;
    if (fromAssigneeId !== toAssigneeId) {
      results.push({
        event: {
          ...baseScope,
          event_type: "assignee_changed",
          issue: issueRef,
          // The base scope's `assignee_id` already reflects the new
          // assignee; carry both sides explicitly for triggers that
          // want to filter on either.
          assignee_id: toAssigneeId,
          to_assignee_id: toAssigneeId,
          from_assignee_id: fromAssigneeId,
        },
        summary: `${identifier} assignee ${fromAssigneeId ?? "∅"} → ${toAssigneeId ?? "∅"}`,
      });
    }
  }

  return results;
}

/**
 * Back-compat shim — the previous mapper returned a single result or
 * null and `MapResult` exposed `fromStateName`. Webhook callers should
 * migrate to `mapIssueEnvelopeToEvents` (plural); kept for any
 * out-of-tree callers that haven't moved over.
 */
export function mapIssueUpdateToEvent(
  envelope: IssueWebhookEnvelope,
  orgId: string,
): (MapResult & { fromStateName: string | null }) | null {
  const all = mapIssueEnvelopeToEvents(envelope, orgId);
  const first = all.find((r) => r.event.event_type === "state_entered");
  if (!first) return null;
  const fromState =
    first.event.event_type === "state_entered" ? first.event.from_state ?? null : null;
  return { ...first, fromStateName: fromState };
}

// ── helpers ───────────────────────────────────────────────────────

interface BaseScope {
  organization_id: string;
  team_id: string | null;
  project_id: string | null;
  assignee_id: string | null;
  labels: string[];
}

function buildBaseScope(data: IssueWebhookData, orgId: string): BaseScope {
  const labels = (data.labels ?? [])
    .map((l) => l.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);

  return {
    organization_id: orgId,
    team_id: data.teamId ?? data.team?.id ?? null,
    project_id: data.projectId ?? data.project?.id ?? null,
    assignee_id: data.assigneeId ?? data.assignee?.id ?? null,
    labels,
  };
}

function buildIssueRef(data: IssueWebhookData) {
  const labels = (data.labels ?? [])
    .map((l) => l.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  return {
    id: data.id,
    identifier: data.identifier ?? null,
    title: data.title ?? null,
    description: data.description ?? null,
    state: data.state?.name ?? null,
    state_id: data.stateId ?? data.state?.id ?? null,
    team_id: data.teamId ?? data.team?.id ?? null,
    project_id: data.projectId ?? data.project?.id ?? null,
    assignee_id: data.assigneeId ?? data.assignee?.id ?? null,
    labels,
    comments: [],
  };
}

/** Cheap discriminator for the webhook router. */
export function isIssueEnvelope(value: unknown): value is IssueWebhookEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "Issue" && typeof v.action === "string";
}
