// Workflow resolver (SYM-295).
//
// Given a normalized EventTuple, find the single best matching
// (workflow, trigger) pair. Implementation is one SQL JOIN over
// `workflow_triggers` × `workflows` with WHERE clauses for the event-
// specific match columns and scope filters, ordered by a derived
// `scope_tier` (user 2 > team 1 > org 0) and then `priority` DESC.
//
// All event-specific match columns use the `(col IS NULL OR col = ?)`
// pattern so a NULL value in the trigger means "match any". Scope-
// filter JSON arrays are NULL-OR-membership checks: we filter in JS
// after the candidate set comes back, since SQLite has no JSON_CONTAINS
// in the base build. The result set is bounded by event_type + scope,
// so the post-filter pass is small.

import type { EventTuple } from "../../schemas/event";
import type { Trigger } from "../../schemas/trigger";
import type { Workflow } from "../../schemas/workflow";

export interface ResolveResult {
  workflow: Workflow;
  trigger: Trigger;
}

interface ResolverEnv {
  DB: D1Database;
}

// ── Public entrypoint ──────────────────────────────────────────────

export async function resolveWorkflow(
  env: ResolverEnv,
  event: EventTuple,
): Promise<ResolveResult | null> {
  // Pull every enabled trigger of this event_type that joins to a
  // published workflow scoped to the event's org/team/user.
  //
  // Equality match columns (`to_state`, `from_state`, `label_name`) are
  // filtered in SQL — they're cheap and let the DB throw out the bulk
  // of non-matching rows. `comment_match` is a regex / substring test,
  // so we apply it in JS along with the JSON-array scope filters.
  const rows = await env.DB.prepare(SELECT_SQL)
    .bind(
      event.event_type,
      // workflow scope — match against the event's org/team/user.
      // Workflow rows have exactly one of (org, team, user) non-null.
      event.organization_id,
      event.team_id ?? null,
      event.user_id ?? null,
      // event-specific equality match columns.
      eventField(event, "to_state"),
      eventField(event, "from_state"),
      eventField(event, "label_name"),
    )
    .all<RawJoinedRow>();

  for (const raw of rows.results ?? []) {
    if (!passesCommentMatch(raw, event)) continue;
    if (!passesScopeFilters(raw, event)) continue;
    return {
      workflow: hydrateWorkflow(raw),
      trigger: hydrateTrigger(raw),
    };
  }
  return null;
}

// ── Internals ──────────────────────────────────────────────────────

const SELECT_SQL = `
  SELECT
    t.id              AS t_id,
    t.workflow_id     AS t_workflow_id,
    t.event_type      AS t_event_type,
    t.to_state        AS t_to_state,
    t.from_state      AS t_from_state,
    t.label_name      AS t_label_name,
    t.comment_match   AS t_comment_match,
    t.team_filter     AS t_team_filter,
    t.project_filter  AS t_project_filter,
    t.label_filter    AS t_label_filter,
    t.skip_label_filter AS t_skip_label_filter,
    t.assignee_filter AS t_assignee_filter,
    t.sentry_project_filter AS t_sentry_project_filter,
    t.level_filter AS t_level_filter,
    t.fingerprint_filter AS t_fingerprint_filter,
    t.environment_filter AS t_environment_filter,
    t.release_filter AS t_release_filter,
    t.action          AS t_action,
    t.action_params   AS t_action_params,
    t.priority        AS t_priority,
    t.enabled         AS t_enabled,
    t.created_at      AS t_created_at,
    t.updated_at      AS t_updated_at,
    w.id                       AS w_id,
    w.organization_id          AS w_organization_id,
    w.team_id                  AS w_team_id,
    w.user_id                  AS w_user_id,
    w.name                     AS w_name,
    w.description              AS w_description,
    w.engine                   AS w_engine,
    w.model                    AS w_model,
    w.max_turns                AS w_max_turns,
    w.max_continuations        AS w_max_continuations,
    w.allowed_tools            AS w_allowed_tools,
    w.disallowed_tools         AS w_disallowed_tools,
    w.allowed_domains          AS w_allowed_domains,
    w.mcp_servers              AS w_mcp_servers,
    w.permission_mode          AS w_permission_mode,
    w.additional_read_paths    AS w_additional_read_paths,
    w.additional_write_paths   AS w_additional_write_paths,
    w.hook_after_create        AS w_hook_after_create,
    w.hook_before_remove       AS w_hook_before_remove,
    w.hook_timeout_ms          AS w_hook_timeout_ms,
    w.prompt_template          AS w_prompt_template,
    w.version                  AS w_version,
    w.status                   AS w_status,
    w.published_at             AS w_published_at,
    w.created_at               AS w_created_at,
    w.updated_at               AS w_updated_at,
    (CASE
       WHEN w.user_id IS NOT NULL THEN 2
       WHEN w.team_id IS NOT NULL THEN 1
       ELSE 0
     END) AS scope_tier
  FROM workflow_triggers t
  JOIN workflows w ON w.id = t.workflow_id
  WHERE t.enabled = 1
    AND w.status  = 'published'
    AND t.event_type = ?
    AND (
         (w.organization_id IS NOT NULL AND w.organization_id = ?)
      OR (w.team_id         IS NOT NULL AND w.team_id         = ?)
      OR (w.user_id         IS NOT NULL AND w.user_id         = ?)
    )
    AND (t.to_state   IS NULL OR t.to_state   = ?)
    AND (t.from_state IS NULL OR t.from_state = ?)
    AND (t.label_name IS NULL OR t.label_name = ?)
  ORDER BY scope_tier DESC, t.priority DESC, t.id ASC
`;

// Read an event-specific match column from the union without
// destructuring — variants without the column return null.
function eventField(
  event: EventTuple,
  key: "to_state" | "from_state" | "label_name",
): string | null {
  const v = (event as unknown as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

// `comment_match` on a trigger is a regex pattern applied to the event's
// `comment` body (only meaningful for `comment_added` events). NULL on
// the trigger means "match any comment". If the regex fails to compile,
// fall back to a substring check so a bad pattern doesn't silently kill
// the trigger.
function passesCommentMatch(raw: RawJoinedRow, event: EventTuple): boolean {
  const pattern = raw.t_comment_match;
  if (pattern == null) return true;
  const body =
    event.event_type === "comment_added"
      ? (event as { comment?: string }).comment ?? ""
      : "";
  try {
    return new RegExp(pattern).test(body);
  } catch {
    return body.includes(pattern);
  }
}

// Scope filters live in JSON arrays. We evaluate them in JS so we can
// model "match any" semantics consistently:
//   - team_filter:       trigger team_filter NULL  → match. Else event.team_id ∈ filter.
//   - project_filter:    trigger project_filter NULL → match. Else event.project_id ∈ filter.
//   - label_filter:      trigger label_filter NULL → match. Else ALL listed labels present.
//   - skip_label_filter: trigger skip_label_filter NULL → match. Else NONE listed labels present.
//   - assignee_filter:   trigger NULL → match. Else event.assignee_id ∈ filter.
function passesScopeFilters(raw: RawJoinedRow, event: EventTuple): boolean {
  const teamFilter = parseStringArray(raw.t_team_filter);
  if (teamFilter && !(event.team_id && teamFilter.includes(event.team_id))) {
    return false;
  }
  const projectFilter = parseStringArray(raw.t_project_filter);
  if (
    projectFilter &&
    !(
      (event.project_id ?? event.issue?.project_id ?? null) &&
      projectFilter.includes((event.project_id ?? event.issue?.project_id)!)
    )
  ) {
    return false;
  }
  const labels = (event.labels ?? []) as string[];
  const labelFilter = parseStringArray(raw.t_label_filter);
  if (labelFilter && !labelFilter.every((l) => labels.includes(l))) {
    return false;
  }
  const skipLabelFilter = parseStringArray(raw.t_skip_label_filter);
  if (skipLabelFilter && skipLabelFilter.some((l) => labels.includes(l))) {
    return false;
  }
  const assigneeFilter = parseStringArray(raw.t_assignee_filter);
  if (assigneeFilter) {
    const id = event.assignee_id ?? null;
    if (!id || !assigneeFilter.includes(id)) return false;
  }
  if (!passesSentryFilters(raw, event)) return false;
  return true;
}

function passesSentryFilters(raw: RawJoinedRow, event: EventTuple): boolean {
  if (!event.event_type.startsWith("sentry.")) return true;
  const rec = event as unknown as Record<string, unknown>;
  const projectFilter = parseStringArray(raw.t_sentry_project_filter);
  if (projectFilter && !projectFilter.includes(String(rec.sentry_project ?? ""))) return false;
  const levelFilter = parseStringArray(raw.t_level_filter);
  if (levelFilter && !levelFilter.includes(String(rec.sentry_level ?? ""))) return false;
  const envFilter = parseStringArray(raw.t_environment_filter);
  if (envFilter && !envFilter.includes(String(rec.sentry_environment ?? ""))) return false;
  const releaseFilter = parseStringArray(raw.t_release_filter);
  if (releaseFilter && !releaseFilter.includes(String(rec.sentry_release ?? ""))) return false;
  if (raw.t_fingerprint_filter) {
    const fingerprints = Array.isArray(rec.sentry_fingerprint)
      ? rec.sentry_fingerprint.map(String)
      : [];
    const haystack = fingerprints.join("\n");
    try {
      if (!new RegExp(raw.t_fingerprint_filter).test(haystack)) return false;
    } catch {
      if (!haystack.includes(raw.t_fingerprint_filter)) return false;
    }
  }
  return true;
}

function parseStringArray(s: string | null): string[] | null {
  if (s == null) return null;
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed as string[];
    }
  } catch {
    // fall through
  }
  return null;
}

function parseJsonOrNull<T>(s: string | null): T | null {
  if (s == null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function hydrateWorkflow(raw: RawJoinedRow): Workflow {
  return {
    id: raw.w_id,
    organization_id: raw.w_organization_id ?? null,
    team_id: raw.w_team_id ?? null,
    user_id: raw.w_user_id ?? null,
    name: raw.w_name,
    description: raw.w_description ?? null,
    engine: raw.w_engine,
    model: raw.w_model ?? null,
    max_turns: raw.w_max_turns,
    max_continuations: raw.w_max_continuations ?? null,
    allowed_tools: parseJsonOrNull<string[]>(raw.w_allowed_tools),
    disallowed_tools: parseJsonOrNull<string[]>(raw.w_disallowed_tools),
    allowed_domains: parseJsonOrNull<string[]>(raw.w_allowed_domains),
    mcp_servers: parseJsonOrNull<Workflow["mcp_servers"]>(raw.w_mcp_servers),
    permission_mode: raw.w_permission_mode ?? null,
    additional_read_paths: parseJsonOrNull<string[]>(
      raw.w_additional_read_paths,
    ),
    additional_write_paths: parseJsonOrNull<string[]>(
      raw.w_additional_write_paths,
    ),
    hook_after_create: raw.w_hook_after_create ?? null,
    hook_before_remove: raw.w_hook_before_remove ?? null,
    hook_timeout_ms: raw.w_hook_timeout_ms,
    prompt_template: raw.w_prompt_template,
    version: raw.w_version,
    status: raw.w_status as Workflow["status"],
    published_at: raw.w_published_at ?? null,
    created_at: raw.w_created_at,
    updated_at: raw.w_updated_at,
  };
}

function hydrateTrigger(raw: RawJoinedRow): Trigger {
  return {
    id: raw.t_id,
    workflow_id: raw.t_workflow_id,
    event_type: raw.t_event_type as Trigger["event_type"],
    to_state: raw.t_to_state ?? null,
    from_state: raw.t_from_state ?? null,
    label_name: raw.t_label_name ?? null,
    comment_match: raw.t_comment_match ?? null,
    team_filter: parseStringArray(raw.t_team_filter),
    project_filter: parseStringArray(raw.t_project_filter),
    label_filter: parseStringArray(raw.t_label_filter),
    skip_label_filter: parseStringArray(raw.t_skip_label_filter),
    assignee_filter: parseStringArray(raw.t_assignee_filter),
    sentry_project_filter: parseStringArray(raw.t_sentry_project_filter),
    level_filter: parseStringArray(raw.t_level_filter) as Trigger["level_filter"],
    fingerprint_filter: raw.t_fingerprint_filter ?? null,
    environment_filter: parseStringArray(raw.t_environment_filter),
    release_filter: parseStringArray(raw.t_release_filter),
    action: raw.t_action as Trigger["action"],
    action_params: parseJsonOrNull<Record<string, unknown>>(raw.t_action_params),
    priority: raw.t_priority,
    enabled: raw.t_enabled === 1,
    created_at: raw.t_created_at,
    updated_at: raw.t_updated_at,
  };
}

// Row shape returned by the SELECT above. Drizzle isn't used here so
// every alias is enumerated explicitly.
interface RawJoinedRow {
  // trigger
  t_id: string;
  t_workflow_id: string;
  t_event_type: string;
  t_to_state: string | null;
  t_from_state: string | null;
  t_label_name: string | null;
  t_comment_match: string | null;
  t_team_filter: string | null;
  t_project_filter: string | null;
  t_label_filter: string | null;
  t_skip_label_filter: string | null;
  t_assignee_filter: string | null;
  t_sentry_project_filter: string | null;
  t_level_filter: string | null;
  t_fingerprint_filter: string | null;
  t_environment_filter: string | null;
  t_release_filter: string | null;
  t_action: string;
  t_action_params: string | null;
  t_priority: number;
  t_enabled: number;
  t_created_at: number;
  t_updated_at: number;
  // workflow
  w_id: string;
  w_organization_id: string | null;
  w_team_id: string | null;
  w_user_id: string | null;
  w_name: string;
  w_description: string | null;
  w_engine: string;
  w_model: string | null;
  w_max_turns: number;
  w_max_continuations: number | null;
  w_allowed_tools: string | null;
  w_disallowed_tools: string | null;
  w_allowed_domains: string | null;
  w_mcp_servers: string | null;
  w_permission_mode: string | null;
  w_additional_read_paths: string | null;
  w_additional_write_paths: string | null;
  w_hook_after_create: string | null;
  w_hook_before_remove: string | null;
  w_hook_timeout_ms: number;
  w_prompt_template: string;
  w_version: number;
  w_status: string;
  w_published_at: number | null;
  w_created_at: number;
  w_updated_at: number;
  scope_tier: number;
}
