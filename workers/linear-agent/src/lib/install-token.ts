/**
 * Refresh the `linear_agent_installs.access_token` for a tenant.
 *
 * The install's `actor=app` token is what we use to post agent
 * activities, transition issues, create attachments, and mint agent
 * sessions on Linear's side. Linear access tokens expire after ~24h
 * and refresh tokens rotate on every successful use — so any path that
 * triggers a refresh must persist both the new access_token AND the
 * new refresh_token atomically, or the next refresh dies with
 * `invalid_grant`.
 *
 * This module mirrors the role of `SymphonyElixir.Linear.OAuth.Refresher`
 * in the orchestrator (`lib/symphony_elixir/linear/oauth/refresher.ex`):
 *
 *   1. Look up the install by `organizations.id`.
 *   2. If `status='reconnect_required'` it's terminal — bail without
 *      hammering Linear's endpoint.
 *   3. Single-flight: concurrent refresh attempts for the same org
 *      within one Worker invocation collapse into one network call
 *      (Linear rotates refresh_tokens, so a race would invalidate
 *      one of the callers' new tokens).
 *   4. Cross-invocation short-circuit: if the install row was already
 *      refreshed within the last few seconds, return the stored token
 *      instead of burning another refresh_token rotation.
 *   5. Exchange via Linear's OAuth `/token` endpoint.
 *   6. Persist the new access_token, rotated refresh_token (if any),
 *      and freshly computed `expires_at` back into D1.
 *   7. On `invalid_grant` / `unauthorized_client`, flip the install
 *      to `status='reconnect_required'` — subsequent refreshes
 *      short-circuit until the user re-runs the OAuth flow.
 *
 * Returns `null` on any failure (missing install, missing client
 * credentials, refresh rejected). Callers should fall back to the
 * existing stored token when null — degraded but better than no run.
 */

import type { Env } from "../index";
import { LinearAgentInstallStore } from "./store";
import {
  OAuthRefreshError,
  refreshOAuthToken,
  tokenNeedsRefreshUnix,
} from "./token-refresh";

export interface RefreshInstallTokenResult {
  accessToken: string;
  expiresAtUnix: number | null;
  refreshed: boolean;
}

// Two install rows are never refreshed concurrently within a single
// Worker invocation — the second caller awaits the first. Keyed by
// organization_id, which is what every caller already has.
//
// The map lives at module scope; Workers' isolate model means it is
// implicitly scoped to one in-flight request (or one Workflow
// instance), so there's no cross-tenant or cross-request leakage.
const inFlightRefreshes = new Map<string, Promise<RefreshInstallTokenResult | null>>();

// Mirrors `@recent_refresh_skip_ms` in `refresher.ex:35`. If another
// invocation refreshed the install row within this window, we re-read
// the row and reuse its stored token rather than calling Linear again
// — protects against burning back-to-back refresh_token rotations on
// near-simultaneous Workflows starts.
const RECENT_REFRESH_SKIP_MS = 5_000;

/**
 * Force a refresh now. Subject to single-flight + recent-refresh dedup.
 * Use when you've observed a 401 and need a guaranteed-fresh token.
 */
export async function refreshInstallToken(
  env: Pick<Env, "DB" | "LINEAR_CLIENT_ID" | "LINEAR_CLIENT_SECRET">,
  organizationId: string,
): Promise<RefreshInstallTokenResult | null> {
  const existing = inFlightRefreshes.get(organizationId);
  if (existing) return existing;

  const p = doRefresh(env, organizationId).finally(() => {
    inFlightRefreshes.delete(organizationId);
  });
  inFlightRefreshes.set(organizationId, p);
  return p;
}

/**
 * Returns a usable access_token for the given org, refreshing only if
 * the stored expires_at falls inside (now + runTimeoutMs + safety). For
 * callers like `SessionRunner.load-token` that previously always
 * refreshed on session start — this version skips the round-trip when
 * the stored token has comfortable runway, matching the proactive
 * path on `SymphonyElixir.Linear.OAuth.fetch_access_token/0`.
 */
export async function refreshInstallTokenIfNeeded(
  env: Pick<Env, "DB" | "LINEAR_CLIENT_ID" | "LINEAR_CLIENT_SECRET">,
  organizationId: string,
  runTimeoutMs: number,
): Promise<RefreshInstallTokenResult | null> {
  const installs = new LinearAgentInstallStore(env.DB);
  const install = await installs.getByOrgId(organizationId);
  if (!install) {
    console.warn("install_token_refresh_no_install", organizationId);
    return null;
  }
  if (install.status === "reconnect_required") {
    console.warn(
      "install_token_refresh_skipped_reconnect_required",
      organizationId,
    );
    return null;
  }
  if (!tokenNeedsRefreshUnix(install.expires_at, runTimeoutMs)) {
    return {
      accessToken: install.access_token,
      expiresAtUnix: install.expires_at,
      refreshed: false,
    };
  }
  return refreshInstallToken(env, organizationId);
}

async function doRefresh(
  env: Pick<Env, "DB" | "LINEAR_CLIENT_ID" | "LINEAR_CLIENT_SECRET">,
  organizationId: string,
): Promise<RefreshInstallTokenResult | null> {
  if (!env.LINEAR_CLIENT_ID || !env.LINEAR_CLIENT_SECRET) {
    console.warn("install_token_refresh_missing_oauth_client");
    return null;
  }

  const installs = new LinearAgentInstallStore(env.DB);
  const install = await installs.getByOrgId(organizationId);
  if (!install) {
    console.warn("install_token_refresh_no_install", organizationId);
    return null;
  }
  if (install.status === "reconnect_required") {
    console.warn(
      "install_token_refresh_skipped_reconnect_required",
      organizationId,
    );
    return null;
  }
  if (!install.refresh_token) {
    console.warn("install_token_refresh_no_refresh_token", organizationId);
    return null;
  }

  // Cross-invocation short-circuit: another caller may have refreshed
  // moments ago and already persisted the rotated token. Reuse it
  // instead of burning a second rotation.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if ((nowSeconds - install.refreshed_at) * 1000 < RECENT_REFRESH_SKIP_MS) {
    return {
      accessToken: install.access_token,
      expiresAtUnix: install.expires_at,
      refreshed: false,
    };
  }

  try {
    const result = await refreshOAuthToken({
      refreshToken: install.refresh_token,
      clientId: env.LINEAR_CLIENT_ID,
      clientSecret: env.LINEAR_CLIENT_SECRET,
    });
    await installs.refreshToken(
      install.id,
      result.accessToken,
      result.refreshToken,
      result.expiresAtUnix,
    );
    return {
      accessToken: result.accessToken,
      expiresAtUnix: result.expiresAtUnix,
      refreshed: true,
    };
  } catch (e) {
    if (e instanceof OAuthRefreshError) {
      console.error(
        "install_token_refresh_failed",
        JSON.stringify({
          organizationId,
          status: e.status,
          invalid_grant: e.invalidGrant,
          body: e.body.slice(0, 200),
        }),
      );
      if (e.invalidGrant) {
        try {
          await installs.markReconnectRequired(install.id);
        } catch (markErr) {
          console.error(
            "install_token_mark_reconnect_failed",
            markErr instanceof Error ? markErr.message : String(markErr),
          );
        }
      }
    } else {
      console.error(
        "install_token_refresh_error",
        e instanceof Error ? e.message : String(e),
      );
    }
    return null;
  }
}
