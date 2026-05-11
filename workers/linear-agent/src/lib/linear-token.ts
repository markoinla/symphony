// Linear MCP credential resolver.
//
// When a Linear Agent Session dispatches to the sandbox, we want to
// attach a user-scoped Linear OAuth token so the agent's MCP can act
// on behalf of a real human (full Linear API surface) rather than
// falling back to the app-scoped install token.
//
// Per-user Linear OAuth tokens are written by Better Auth's
// `genericOAuth` plugin (configured in src/lib/auth.ts) into the
// `accounts` table with `providerId = 'linear'`. To pick the right
// token for an org we:
//
//   1. Join `accounts` ↔ `members` on userId, filtered to the
//      requested organizationId and providerId='linear'.
//   2. Order candidates with the triggering user first, then anyone
//      else (today's heuristic — see "Limitations" below).
//   3. For each candidate, if the access token will expire inside the
//      run window (+ small safety margin) and we have a refresh
//      token, refresh via `refreshOAuthToken` and persist the new
//      tokens back to the row. Otherwise return as-is.
//   4. Return the first candidate that yields a usable token.
//
// Returns null if no member in the org has linked Linear (the agent
// then runs without the Linear MCP attached — the dispatcher falls
// back to the install's app-scoped token for activity posting, which
// is enough for the basic workflow).
//
// Limitations:
//   - Multi-member orgs are not round-robin'd. We always prefer the
//     triggering user, then fall through to anyone in insertion order
//     from D1. Picking a less-stale token / load-balancing across
//     members can come later if rate limits bite.

import type { D1Database } from "@cloudflare/workers-types";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { accounts, members } from "../db/auth.schema";
import { schema } from "../db/schema";
import {
  OAuthRefreshError,
  refreshOAuthToken,
  tokenNeedsRefresh,
} from "./token-refresh";

export interface LinearTokenResult {
  accessToken: string;
  userId: string;
  refreshed: boolean;
}

export interface ResolveLinearMcpTokenEnv {
  DB: D1Database;
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
}

export interface ResolveParams {
  env: ResolveLinearMcpTokenEnv;
  organizationId: string;
  triggeringUserId: string | null;
  runTimeoutMs: number;
}

interface Candidate {
  accountRowId: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
}

export async function resolveLinearMcpToken(
  params: ResolveParams,
): Promise<LinearTokenResult | null> {
  const { env, organizationId, triggeringUserId, runTimeoutMs } = params;

  const db = drizzle(env.DB, { schema });

  const rows = await db
    .select({
      accountRowId: accounts.id,
      userId: accounts.userId,
      accessToken: accounts.accessToken,
      refreshToken: accounts.refreshToken,
      accessTokenExpiresAt: accounts.accessTokenExpiresAt,
    })
    .from(accounts)
    .innerJoin(members, eq(members.userId, accounts.userId))
    .where(
      and(
        eq(accounts.providerId, "linear"),
        eq(members.organizationId, organizationId),
      ),
    )
    .all();

  if (rows.length === 0) return null;

  const candidates: Candidate[] = rows.filter(
    (r): r is Candidate => typeof r.accessToken === "string" || r.refreshToken !== null,
  );

  // Triggering user first, then everyone else in insertion order.
  candidates.sort((a, b) => {
    if (triggeringUserId) {
      if (a.userId === triggeringUserId && b.userId !== triggeringUserId)
        return -1;
      if (b.userId === triggeringUserId && a.userId !== triggeringUserId)
        return 1;
    }
    return 0;
  });

  for (const candidate of candidates) {
    const result = await tryCandidate(db, env, candidate, runTimeoutMs);
    if (result) return result;
  }

  return null;
}

async function tryCandidate(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: ResolveLinearMcpTokenEnv,
  candidate: Candidate,
  runTimeoutMs: number,
): Promise<LinearTokenResult | null> {
  const expiresIso = candidate.accessTokenExpiresAt
    ? candidate.accessTokenExpiresAt.toISOString()
    : null;

  const stale = tokenNeedsRefresh(expiresIso, runTimeoutMs);

  if (!stale && candidate.accessToken) {
    return {
      accessToken: candidate.accessToken,
      userId: candidate.userId,
      refreshed: false,
    };
  }

  // Stale or missing access token — try a refresh.
  if (!candidate.refreshToken) return null;
  if (!env.LINEAR_CLIENT_ID || !env.LINEAR_CLIENT_SECRET) return null;

  try {
    const refreshed = await refreshOAuthToken({
      refreshToken: candidate.refreshToken,
      clientId: env.LINEAR_CLIENT_ID,
      clientSecret: env.LINEAR_CLIENT_SECRET,
    });

    const newExpiresAt = refreshed.expiresAt
      ? new Date(refreshed.expiresAt)
      : null;

    await db
      .update(accounts)
      .set({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? candidate.refreshToken,
        accessTokenExpiresAt: newExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, candidate.accountRowId))
      .run();

    return {
      accessToken: refreshed.accessToken,
      userId: candidate.userId,
      refreshed: true,
    };
  } catch (err) {
    if (err instanceof OAuthRefreshError) {
      console.warn(
        "linear_token_refresh_failed",
        JSON.stringify({
          userId: candidate.userId,
          status: err.status,
          body: err.body.slice(0, 200),
        }),
      );
    } else {
      console.warn(
        "linear_token_refresh_error",
        err instanceof Error ? err.message : String(err),
      );
    }
    return null;
  }
}
