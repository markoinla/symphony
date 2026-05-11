// Better Auth instance for the linear-agent Worker.
//
// Dual-mode export pattern (per better-auth-cloudflare docs):
//   - `auth` (singleton, no env) is used by `@better-auth/cli generate`
//     to produce the Drizzle schema. It's safe to import at module load
//     because it never touches a live D1.
//   - `createAuth(env, cf, baseURL)` is the runtime factory. The Hono
//     handler calls it on each request because Workers have one env
//     per request and we want geolocation + IP from `c.req.raw.cf`.
//
// Auth surface (Phase 2):
//   - Email/password (Better Auth core)
//   - GitHub OAuth (built-in social provider)
//   - Linear OAuth (genericOAuth — Linear doesn't have OIDC discovery)
//   - Organizations + teams + invitations (organization plugin)
//
// We intentionally do not enable email verification yet — Workers have
// no built-in email sender. We'll wire that to Resend/Postmark when
// invitation emails get implemented.

import type {
  D1Database,
  IncomingRequestCfProperties,
  KVNamespace,
} from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import { genericOAuth, organization } from "better-auth/plugins";
import { withCloudflare } from "better-auth-cloudflare";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";

import { schema } from "../db/schema";

export interface AuthEnv {
  DB: D1Database;
  LINEAR_TOKENS: KVNamespace;
  URL: string;
  BETTER_AUTH_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
}

export function createAuth(
  env?: AuthEnv,
  cf?: IncomingRequestCfProperties,
  baseURL?: string,
) {
  // Drizzle wants a schema at module-load time even for the CLI path,
  // hence the `({} as any)` fallback. The real DB is only attached
  // when an env is provided (runtime).
  const db = env ? drizzle(env.DB, { schema, logger: false }) : ({} as never);

  const linearProvider = env?.LINEAR_CLIENT_ID && env?.LINEAR_CLIENT_SECRET
    ? [
        {
          providerId: "linear",
          clientId: env.LINEAR_CLIENT_ID,
          clientSecret: env.LINEAR_CLIENT_SECRET,
          authorizationUrl: "https://linear.app/oauth/authorize",
          tokenUrl: "https://api.linear.app/oauth/token",
          scopes: ["read", "write"],
          // Linear's GraphQL `viewer` is how we resolve the
          // authenticated user. Better Auth's genericOAuth supports a
          // custom `getUserInfo` for this.
          getUserInfo: async (tokens: { accessToken?: string }) => {
            if (!tokens.accessToken) return null;
            const res = await fetch("https://api.linear.app/graphql", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${tokens.accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                query: "{ viewer { id email name avatarUrl } }",
              }),
            });
            const json = (await res.json()) as {
              data?: {
                viewer?: {
                  id: string;
                  email: string | null;
                  name: string | null;
                  avatarUrl: string | null;
                };
              };
            };
            const v = json.data?.viewer;
            if (!v) return null;
            return {
              id: v.id,
              email: v.email ?? `${v.id}@users.linear.app`,
              name: v.name ?? v.id,
              image: v.avatarUrl ?? undefined,
              emailVerified: false,
            };
          },
        },
      ]
    : [];

  return betterAuth({
    baseURL,
    secret: env?.BETTER_AUTH_SECRET,
    ...withCloudflare(
      {
        autoDetectIpAddress: true,
        geolocationTracking: false, // off until we add geo columns
        cf: cf || {},
        d1: env
          ? {
              db,
              options: {
                usePlural: true,
                debugLogs: false,
              },
            }
          : undefined,
        // KV intentionally omitted — when set, withCloudflare uses it
        // as primary session storage and the organization plugin's
        // activeOrganizationId updates against the D1 `sessions` table
        // become no-ops. We get rate limiting via in-memory fallback
        // (per-Worker instance, not cluster-wide) which is fine pre-prod.
      },
      {
        emailAndPassword: {
          enabled: true,
          minPasswordLength: 8,
        },
        socialProviders:
          env?.GITHUB_CLIENT_ID && env?.GITHUB_CLIENT_SECRET
            ? {
                github: {
                  clientId: env.GITHUB_CLIENT_ID,
                  clientSecret: env.GITHUB_CLIENT_SECRET,
                },
              }
            : undefined,
        plugins: [
          organization({
            teams: { enabled: true },
            allowUserToCreateOrganization: true,
          }),
          ...(linearProvider.length > 0
            ? [genericOAuth({ config: linearProvider })]
            : []),
        ],
        // Rate limiting needs KV (Workers have no shared memory across
        // invocations). Disabled until we re-add KV in a way that
        // doesn't shadow D1 session writes.
        rateLimit: {
          enabled: false,
        },
      },
    ),
    // CLI fallback adapter (no env). Better Auth's CLI walks this to
    // emit the Drizzle schema for migration generation.
    ...(env
      ? {}
      : {
          database: drizzleAdapter({} as D1Database, {
            provider: "sqlite",
            usePlural: true,
          }),
        }),
  });
}

// CLI export — `@better-auth/cli generate --config src/lib/auth.ts`.
// Do not call at runtime; use createAuth(env, cf, baseURL) instead.
export const auth = createAuth();

export type Auth = ReturnType<typeof createAuth>;
