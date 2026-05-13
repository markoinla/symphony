/**
 * Zombie-session reconciliation.
 *
 * SessionRunner wraps its terminal D1 write in a try/catch (see
 * `workflows/session-runner.ts`), so the normal path always closes the
 * `agent_sessions` row out. This cron is the fallback for cases that
 * try/catch can't reach:
 *   - the catch block's D1 write itself fails (a transient D1 outage),
 *   - a future caller forgets to wrap their session-runner entry, or
 *   - the workflow instance is force-terminated by an operator and the
 *     D1 row is left behind.
 *
 * Heuristic: any `agent_sessions` row with status='running' whose
 * `started_at` is older than STALE_AFTER_SECONDS is checked against
 * the workflow runtime. If the workflow instance is in a terminal
 * state (`errored`, `terminated`, `complete`) or can't be looked up
 * (the binding throws on unknown id), the row is reconciled to
 * `error`. Workflows still in `queued`/`running`/`paused`/`waiting`
 * are left alone — they're legitimately in-flight.
 *
 * Intentionally cheap: bounded LIMIT, one status() RPC per row,
 * sequential to keep the cron's CPU budget small. If we ever see a
 * large zombie backlog this should move to a paginated batch.
 */

import type { Env } from "../index";
import { AgentSessionStore } from "./store";

// Linear marks sessions stale after ~30 min and our `step.waitForEvent`
// caps at 25 min, so a "running" row older than 90 min that isn't
// actually still in-flight is unambiguously a zombie. Picked
// generously to avoid racing against legitimately long sessions.
const STALE_AFTER_SECONDS = 90 * 60;

// Cap rows per tick so a backlog can't blow the cron's CPU budget.
// At 5-minute cadence this drains ≤ 120 zombies/hour.
const MAX_RECONCILE_PER_TICK = 10;

const TERMINAL_INSTANCE_STATUSES = new Set([
  "errored",
  "terminated",
  "complete",
]);

export interface ReconcileResult {
  scanned: number;
  reconciled: number;
  skipped: number;
}

export async function reconcileZombieSessions(
  env: Env,
): Promise<ReconcileResult> {
  const cutoff = Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS;

  // Inlined SQL — AgentSessionStore doesn't have a "list-stale" method
  // and the rest of the worker has no need for one. Keeping it here
  // localizes the heuristic.
  const stale = await env.DB.prepare(
    `SELECT id FROM agent_sessions
     WHERE status = 'running' AND started_at < ?
     ORDER BY started_at ASC
     LIMIT ?`,
  )
    .bind(cutoff, MAX_RECONCILE_PER_TICK)
    .all<{ id: string }>();

  let reconciled = 0;
  let skipped = 0;

  for (const row of stale.results) {
    const decision = await classifyInstance(env, row.id);
    if (decision === "leave") {
      skipped++;
      continue;
    }

    try {
      await new AgentSessionStore(env.DB).update(row.id, {
        status: "error",
        completedAt: Math.floor(Date.now() / 1000),
        // COALESCE-style: only fill `error` when it's currently null.
        // We can't express that in the store's update API, so write a
        // distinct sentinel and let the dashboard show it for what it
        // is — a janitor-detected zombie, not an in-band failure.
        error: `reconciled_zombie_session: ${decision}`,
      });
      reconciled++;
    } catch (e) {
      console.error(
        "reconciler_update_failed",
        JSON.stringify({
          session_id: row.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      skipped++;
    }
  }

  return {
    scanned: stale.results.length,
    reconciled,
    skipped,
  };
}

/**
 * Decide whether to leave a stale row alone or close it out, based on
 * what the workflow runtime knows about the instance.
 *
 * Returns either `"leave"` (instance is still legitimately in-flight)
 * or a short reason string explaining the terminal state we observed,
 * which gets embedded in the D1 `error` column.
 */
async function classifyInstance(
  env: Env,
  sessionId: string,
): Promise<"leave" | string> {
  let instance;
  try {
    instance = await env.SESSION_RUNNER.get(sessionId);
  } catch (e) {
    // The binding throws when the instance id is unknown. This
    // happens after Workflows has aged the instance out of its
    // retention window — at that point we know it's not coming
    // back, so reconcile.
    return `instance_unknown: ${e instanceof Error ? e.message : String(e)}`;
  }

  let status;
  try {
    status = await instance.status();
  } catch (e) {
    return `status_lookup_failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (TERMINAL_INSTANCE_STATUSES.has(status.status)) {
    return `instance_${status.status}${status.error ? `: ${status.error.message}` : ""}`;
  }

  // `unknown` is the binding's "I don't know" state — treat as
  // not-yet-terminal so we re-check next tick instead of incorrectly
  // marking a healthy run as error.
  return "leave";
}
