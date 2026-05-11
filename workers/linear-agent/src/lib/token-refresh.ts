/**
 * Linear user OAuth token refresh.
 *
 * Linear MCP authenticates via standard OAuth, and pi's MCP client
 * takes a bearer and uses it until it sees a 401 — it does NOT
 * refresh itself. If a token expires mid-run, MCP calls start
 * failing partway through. Strategy: refresh aggressively in
 * linear-agent so the token is guaranteed fresh for at least the
 * full /run timeout window.
 *
 * The same primitive (`refreshIfExpiring`) should work for any
 * future OAuth-able MCP server. For now there's only one provider —
 * keep it Linear-specific until a second one needs it, then factor
 * the URL out behind a provider switch.
 */

import { OAuthHelper } from "./oauth-helper";
import {
  InstallationStore,
  UserStore,
  type InstallationRecord,
  type UserRecord,
} from "./store";

export interface TokenRefreshEnv {
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  DB: D1Database;
}

const DEFAULT_SAFETY_MARGIN_MS = 2 * 60 * 1000; // 2 min

export interface ResolvedUserToken {
  /** Fresh access token usable as the Linear MCP bearer. */
  accessToken: string;
  /** D1 `users` row id; useful for logging. */
  userId: string;
  /** Linear user id; matches webhook `actor.id`. */
  linearUserId: string;
  /** "triggered_by" if the run was started by this user; "installer"
   *  if we fell back to the install owner; "fallback" otherwise. */
  source: "triggered_by" | "installer" | "fallback";
}

/**
 * Pick the best user token for a /run on `organizationId`.
 *
 * Order:
 *   1. The webhook actor (if logged into the dashboard, fresh, or
 *      refreshable).
 *   2. The installer (always logged in via the install→user redirect).
 *   3. null — caller omits the Linear MCP credential from the /run.
 *
 * Each candidate is refreshed via `refreshIfExpiring` before being
 * returned. On refresh failure the candidate is treated as dead and
 * we fall through to the next one.
 */
export async function pickBestUserToken(
  env: TokenRefreshEnv,
  organizationId: string,
  triggeredByLinearUserId: string | null,
  runTimeoutMs: number,
): Promise<ResolvedUserToken | null> {
  const users = new UserStore(env.DB);
  const installs = new InstallationStore(env.DB);

  const tried: string[] = [];

  if (triggeredByLinearUserId) {
    const candidate = await users.getByOrgAndLinearId(
      organizationId,
      triggeredByLinearUserId,
    );
    if (candidate) {
      const fresh = await tryRefresh(env, candidate, runTimeoutMs);
      if (fresh) {
        return {
          accessToken: fresh.accessToken,
          userId: candidate.id,
          linearUserId: candidate.linear_user_id,
          source: "triggered_by",
        };
      }
      tried.push(candidate.id);
    }
  }

  const install = await installs.get(organizationId);
  if (install?.installed_by_linear_user_id) {
    const candidate = await users.getByOrgAndLinearId(
      organizationId,
      install.installed_by_linear_user_id,
    );
    if (candidate && !tried.includes(candidate.id)) {
      const fresh = await tryRefresh(env, candidate, runTimeoutMs);
      if (fresh) {
        return {
          accessToken: fresh.accessToken,
          userId: candidate.id,
          linearUserId: candidate.linear_user_id,
          source: "installer",
        };
      }
    }
  }

  return null;
}

/**
 * Refresh a single user's token if it's within
 * `runTimeoutMs + safetyMargin` of expiring. Persists the new
 * access/refresh pair to D1 and returns the access token. Returns
 * null on refresh failure (revoked, network error, etc.) so the
 * caller can fall back.
 *
 * Exported in case a future caller wants to refresh a specific user
 * outside of the picker.
 */
export async function refreshIfExpiring(
  env: TokenRefreshEnv,
  user: UserRecord,
  runTimeoutMs: number,
  safetyMarginMs: number = DEFAULT_SAFETY_MARGIN_MS,
): Promise<{ accessToken: string } | null> {
  const expiresAtMs = Date.parse(user.expires_at);
  const cutoff = Date.now() + runTimeoutMs + safetyMarginMs;
  if (Number.isFinite(expiresAtMs) && expiresAtMs > cutoff) {
    return { accessToken: user.access_token };
  }
  if (!user.refresh_token) {
    // No refresh token (e.g. user only stored an old session that
    // pre-dates refresh support). Treat as dead so the picker tries
    // the next candidate.
    return null;
  }
  try {
    const tokens = await OAuthHelper.refreshToken(
      user.refresh_token,
      env.LINEAR_CLIENT_ID,
      env.LINEAR_CLIENT_SECRET,
    );
    const newExpiresAt = new Date(
      Date.now() + tokens.expires_in * 1000,
    ).toISOString();
    await new UserStore(env.DB).updateTokens({
      id: user.id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: newExpiresAt,
    });
    return { accessToken: tokens.access_token };
  } catch (e) {
    console.error(
      "linear_user_refresh_failed",
      JSON.stringify({
        user_id: user.id,
        org_id: user.organization_id,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return null;
  }
}

async function tryRefresh(
  env: TokenRefreshEnv,
  user: UserRecord,
  runTimeoutMs: number,
): Promise<{ accessToken: string } | null> {
  return refreshIfExpiring(env, user, runTimeoutMs);
}

// Re-export for callers that want the install record's
// installed_by_linear_user_id mid-stream without re-fetching.
export type { InstallationRecord, UserRecord };
