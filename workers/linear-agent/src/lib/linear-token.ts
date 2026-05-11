/**
 * Token selection and aggressive refresh for Linear MCP credentials.
 *
 * Before each `/run`, picks the "best" user token for the org:
 *   1. The user who triggered the session (if they've logged into the dashboard)
 *   2. The installer (always present after install flow)
 *   3. null (omit Linear MCP — pi runs without Linear tools)
 *
 * For the chosen token, refreshes aggressively if it expires within
 * `run_timeout_ms + safety_margin` so the token stays valid for the
 * entire run window.
 */

import type { UserRecord, UserStore } from "./store";
import {
  type OAuthRefreshResult,
  OAuthRefreshError,
  refreshOAuthToken,
  tokenNeedsRefresh,
} from "./token-refresh";

export interface LinearTokenResult {
  accessToken: string;
  userId: string;
  refreshed: boolean;
}

interface ResolveParams {
  orgId: string;
  triggeringUserId: string | null;
  userStore: UserStore;
  clientId: string;
  clientSecret: string;
  runTimeoutMs: number;
}

export async function resolveLinearMcpToken(
  params: ResolveParams,
): Promise<LinearTokenResult | null> {
  const {
    orgId,
    triggeringUserId,
    userStore,
    clientId,
    clientSecret,
    runTimeoutMs,
  } = params;

  const candidates = await buildCandidateList(
    userStore,
    orgId,
    triggeringUserId,
  );

  for (const user of candidates) {
    const result = await tryUserToken(user, {
      userStore,
      clientId,
      clientSecret,
      runTimeoutMs,
    });
    if (result) return result;
  }

  console.warn(
    "linear_mcp_token_unavailable",
    JSON.stringify({
      orgId,
      triggeringUserId,
      candidateCount: candidates.length,
    }),
  );
  return null;
}

async function buildCandidateList(
  userStore: UserStore,
  orgId: string,
  triggeringUserId: string | null,
): Promise<UserRecord[]> {
  const candidates: UserRecord[] = [];

  if (triggeringUserId) {
    const triggeringUser =
      await userStore.getByLinearUserId(triggeringUserId);
    if (triggeringUser && triggeringUser.organization_id === orgId) {
      candidates.push(triggeringUser);
    }
  }

  const orgUsers = await userStore.listByOrg(orgId);
  for (const user of orgUsers) {
    if (
      candidates.length > 0 &&
      candidates[0]!.linear_user_id === user.linear_user_id
    ) {
      continue;
    }
    candidates.push(user);
  }

  return candidates;
}

async function tryUserToken(
  user: UserRecord,
  ctx: {
    userStore: UserStore;
    clientId: string;
    clientSecret: string;
    runTimeoutMs: number;
  },
): Promise<LinearTokenResult | null> {
  if (!tokenNeedsRefresh(user.expires_at, ctx.runTimeoutMs)) {
    return {
      accessToken: user.access_token,
      userId: user.linear_user_id,
      refreshed: false,
    };
  }

  if (!user.refresh_token) {
    console.warn(
      "linear_token_expiring_no_refresh_token",
      JSON.stringify({
        userId: user.linear_user_id,
        expiresAt: user.expires_at,
      }),
    );
    return null;
  }

  try {
    const refreshed = await refreshOAuthToken({
      refreshToken: user.refresh_token,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
    });

    await ctx.userStore.upsert({
      linearUserId: user.linear_user_id,
      organizationId: user.organization_id,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      email: user.email,
      name: user.name,
    });

    return {
      accessToken: refreshed.accessToken,
      userId: user.linear_user_id,
      refreshed: true,
    };
  } catch (e) {
    const detail =
      e instanceof OAuthRefreshError
        ? `${e.status}: ${e.body.slice(0, 200)}`
        : e instanceof Error
          ? e.message
          : String(e);
    console.warn(
      "linear_token_refresh_failed",
      JSON.stringify({
        userId: user.linear_user_id,
        orgId: user.organization_id,
        error: detail,
      }),
    );
    return null;
  }
}
