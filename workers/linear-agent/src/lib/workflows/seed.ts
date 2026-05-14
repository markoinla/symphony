// Lazy-seed the "Engineering Default" workflow + its six example
// triggers on first webhook for an organization. Idempotent — if any
// workflow row already exists for the org we skip.
//
// The columns mirror migrations/0002_workflows.sql. We talk to D1
// directly (no Drizzle) because the seed runs from a Cloudflare Worker
// without a long-lived client.

import type { Env } from "../../index";

const DEFAULT_NAME = "Engineering Default";
const DEFAULT_DESCRIPTION =
  "Default workflow seeded on org install. Move issues to Todo to start, label `blocked` to stop.";
const DEFAULT_ENGINE = "pi";
const DEFAULT_PROMPT_TEMPLATE = `You are working on Linear issue {{ issue.identifier }} - {{ issue.title }}.

Read the issue description and recent comments, then propose and execute a plan.`;

interface SeedTrigger {
  event_type: string;
  to_state: string | null;
  from_state: string | null;
  label_name: string | null;
  comment_match: string | null;
  action: string;
  action_params: Record<string, unknown> | null;
  priority: number;
}

const SEED_TRIGGERS: SeedTrigger[] = [
  // 1. AgentSession kickoff — highest priority so it wins ties with
  //    state-based triggers.
  {
    event_type: "session_started",
    to_state: null,
    from_state: null,
    label_name: null,
    comment_match: null,
    action: "start_session",
    action_params: null,
    priority: 100,
  },
  // 2. Issue moved into Todo — starts a fresh run.
  {
    event_type: "state_entered",
    to_state: "Todo",
    from_state: null,
    label_name: null,
    comment_match: null,
    action: "start_session",
    action_params: null,
    priority: 50,
  },
  // 3. Issue moved into Rework — resets and re-runs (logs only today;
  //    runner-side reset model is a follow-up).
  {
    event_type: "state_entered",
    to_state: "Rework",
    from_state: null,
    label_name: null,
    comment_match: null,
    action: "reset_session",
    action_params: null,
    priority: 50,
  },
  // 4. Issue moved into Merging — run the `land` skill (logs only).
  {
    event_type: "state_entered",
    to_state: "Merging",
    from_state: null,
    label_name: null,
    comment_match: null,
    action: "continue_session",
    action_params: { skill: "land" },
    priority: 50,
  },
  // 5. `blocked` label applied — stops the current run.
  {
    event_type: "label_added",
    to_state: null,
    from_state: null,
    label_name: "blocked",
    comment_match: null,
    action: "stop_session",
    action_params: null,
    priority: 60,
  },
];

/**
 * Insert the "Engineering Default" workflow if the org has none yet.
 *
 * Wrapped in try/catch so a missing-table failure (Track 1 migration
 * not yet applied) doesn't break the webhook handler.
 */
export async function ensureDefaultWorkflow(
  env: Env,
  orgId: string,
): Promise<void> {
  try {
    const existing = await env.DB.prepare(
      `SELECT id FROM workflows WHERE organization_id = ? LIMIT 1`,
    )
      .bind(orgId)
      .first<{ id: string }>();
    if (existing) return;

    const now = Math.floor(Date.now() / 1000);
    const workflowId = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO workflows (
         id, organization_id, team_id, user_id,
         name, description,
         engine, model, max_turns, max_continuations,
         allowed_tools, disallowed_tools, allowed_domains, mcp_servers,
         permission_mode, additional_read_paths, additional_write_paths,
         hook_after_create, hook_before_remove, hook_timeout_ms,
         prompt_template,
         version, status, published_at,
         created_at, updated_at
       )
       VALUES (
         ?, ?, NULL, NULL,
         ?, ?,
         ?, NULL, 10, 5,
         NULL, NULL, NULL, NULL,
         NULL, NULL, NULL,
         NULL, NULL, 300000,
         ?,
         1, 'published', ?,
         ?, ?
       )`,
    )
      .bind(
        workflowId,
        orgId,
        DEFAULT_NAME,
        DEFAULT_DESCRIPTION,
        DEFAULT_ENGINE,
        DEFAULT_PROMPT_TEMPLATE,
        now,
        now,
        now,
      )
      .run();

    for (const t of SEED_TRIGGERS) {
      await env.DB.prepare(
        `INSERT INTO workflow_triggers (
           id, workflow_id, event_type,
           to_state, from_state, label_name, comment_match,
           team_filter, project_filter, label_filter, skip_label_filter, assignee_filter,
           action, action_params, priority, enabled,
           created_at, updated_at
         )
         VALUES (
           ?, ?, ?,
           ?, ?, ?, ?,
           NULL, NULL, NULL, NULL, NULL,
           ?, ?, ?, 1,
           ?, ?
         )`,
      )
        .bind(
          crypto.randomUUID(),
          workflowId,
          t.event_type,
          t.to_state,
          t.from_state,
          t.label_name,
          t.comment_match,
          t.action,
          t.action_params ? JSON.stringify(t.action_params) : null,
          t.priority,
          now,
          now,
        )
        .run();
    }
    console.info("seeded_default_workflow", {
      org_id: orgId,
      workflow_id: workflowId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table|does not exist/i.test(msg)) {
      return;
    }
    console.error("seed_default_workflow_failed", msg);
  }
}
