import type { Env } from "./index";

/**
 * Shared sandbox-related constants + helpers used by every route that
 * touches the Cloudflare Sandbox SDK (`/auth/*`, `/run`, `/auth/refresh`).
 *
 * Extracted into one module after the Phase 6 refresh job became the third
 * place that needed them — promoting per the doc's standing TODO ("promote
 * `safeDestroy` to `src/sandbox-helpers.ts` if you find yourself
 * repeating").
 */

// SDK-allowed backup roots: /workspace, /home, /tmp, /var/tmp, /app. /root
// is *not* allowed (rejected by validateBackupDir). We park the operator's
// HOME at /home/symphony and route ttyd, npm prefix, and CLI auth files
// there so the snapshot captures everything in one shot.
export const SNAPSHOT_DIR = "/home/symphony";
export const SANDBOX_HOME = SNAPSHOT_DIR;

// Snapshot R2 retention (seconds). 7 days is enough cushion for the cron
// refresh to keep credentials rolling forward; the bucket-level lifecycle
// rule then GCs anything that goes stale at 14 days.
export const SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Sanitize a scope (or any caller-supplied string) into a DNS-safe label
 * suitable for embedding in a sandbox ID. The SDK's preview URL builder
 * (`baseUrl.hostname = "${port}-${id}-${token}.${host}"`) silently rejects
 * hostnames containing colons, dots mid-label, or `@`, leaving the URL
 * pointing at the bare host. Everything that derives a sandbox ID from a
 * caller value funnels through this.
 */
export function sanitizeScopeForId(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
}

/**
 * Operators opt into local-bucket mode by setting `USE_LOCAL_BACKUP_BUCKET`
 * to "true" in the dev env (or via `wrangler secret put`). Production
 * leaves it unset so the SDK uses the default presigned-PUT flow, which is
 * significantly faster for large snapshots.
 */
export function useLocalBackupBucket(env: Env): boolean {
  return env.USE_LOCAL_BACKUP_BUCKET === "true";
}

/**
 * `getProcess` with a missing process normalized to `null`.
 *
 * The Sandbox SDK's `getProcess` is *not* uniformly null-returning: its
 * HTTP layer throws `ProcessNotFoundError` when the container answers 404
 * for an unknown process id, and only returns `null` for the rarer
 * 200-with-empty-body case. Both mean the same thing — "no such process" —
 * so callers that want a plain absence check must funnel through here.
 *
 * Any other failure (sandbox unreachable, transport error) is genuine and
 * re-thrown. Matched on `name` rather than an `instanceof` because
 * `ProcessNotFoundError` is not exported from `@cloudflare/sandbox`.
 */
export async function getProcessOrNull<T>(
  sandbox: { getProcess(processId: string): Promise<T | null> },
  processId: string,
): Promise<T | null> {
  try {
    return await sandbox.getProcess(processId);
  } catch (e) {
    if (e instanceof Error && e.name === "ProcessNotFoundError") return null;
    throw e;
  }
}

/**
 * Tear a sandbox down without throwing. Cleanup failures are deliberately
 * swallowed: the sandbox may already be gone (idle GC, prior destroy), and
 * a teardown error shouldn't mask the real result of whatever the caller
 * was doing.
 */
export async function safeDestroy(sandbox: {
  destroy(): Promise<void>;
}): Promise<void> {
  try {
    await sandbox.destroy();
  } catch {
    // Intentional: see docstring.
  }
}
