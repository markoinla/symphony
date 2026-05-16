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
 * True when an error means "the sandbox has no such process".
 *
 * The Sandbox SDK throws `ProcessNotFoundError` for a container 404, but
 * detecting it is awkward for two reasons:
 *
 *  1. The class is not exported from `@cloudflare/sandbox`, so there is no
 *     `instanceof` to match on.
 *  2. `getSandbox` returns a Durable Object stub — every `getProcess` /
 *     `getProcessLogs` call is a DO RPC. workerd cannot reconstruct a
 *     non-standard error subclass across that boundary: on the Worker side
 *     the error arrives as a plain `Error` with `name === "Error"` and the
 *     original class name folded into `message`
 *     (e.g. "ProcessNotFoundError: Process engine-… not found").
 *
 * So `name` is only reliable for an in-isolate throw (tests); in production
 * the signal lives in the message. Match both. A false positive here just
 * surfaces a recoverable `process_not_found`, so the loose message match is
 * an acceptable trade against missing the real thing.
 */
export function isProcessNotFoundError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "ProcessNotFoundError") return true;
  return /ProcessNotFoundError|Process\s+\S+\s+not found/i.test(e.message);
}

/**
 * `getProcess` with a missing process normalized to `null`.
 *
 * `getProcess` is *not* uniformly null-returning: it throws
 * `ProcessNotFoundError` when the container answers 404 for an unknown
 * process id, and only returns `null` for the rarer 200-with-empty-body
 * case. Both mean "no such process", so callers that want a plain absence
 * check must funnel through here. Any other failure (sandbox unreachable,
 * transport error) is genuine and re-thrown.
 */
export async function getProcessOrNull<T>(
  sandbox: { getProcess(processId: string): Promise<T | null> },
  processId: string,
): Promise<T | null> {
  try {
    return await sandbox.getProcess(processId);
  } catch (e) {
    if (isProcessNotFoundError(e)) return null;
    throw e;
  }
}

/**
 * `getProcessLogs` with a missing process normalized to `null`.
 *
 * Like `getProcess`, the logs endpoint throws `ProcessNotFoundError` when
 * the process record has vanished (sandbox destroyed/GC'd out from under a
 * live tail). Callers treat `null` as the same terminal signal as a
 * `getProcessOrNull` miss; any other failure is re-thrown.
 */
export async function getProcessLogsOrNull<T>(
  sandbox: { getProcessLogs(processId: string): Promise<T> },
  processId: string,
): Promise<T | null> {
  try {
    return await sandbox.getProcessLogs(processId);
  } catch (e) {
    if (isProcessNotFoundError(e)) return null;
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
