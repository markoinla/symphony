/**
 * Resolve the agent's own Linear user id (the install's `viewer`) so we
 * can set `Issue.delegate` to ourselves on session start.
 *
 * Linear treats the `actor=app` install token as a synthetic user; its
 * user id never changes for a given org install. We cache the lookup
 * in KV under `viewer:<linearOrgId>` with a generous TTL so we only
 * hit Linear's GraphQL on cold starts or post-reinstall.
 *
 * The fetch shape mirrors the existing `viewer { id }` queries in
 * `oauth-helper.ts` / `auth.ts`.
 */

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const VIEWER_TTL_SECONDS = 24 * 60 * 60; // 24h — viewer id is stable
const VIEWER_QUERY = `query { viewer { id } }`;

export interface ViewerCache {
  // Subset of KVNamespace we use, kept narrow so the helper is easy to
  // stub in unit tests without dragging the full Workers types in.
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

/**
 * Returns the agent's Linear user id for this install, caching the
 * result in `cache` keyed by `linearOrgId`. Returns `null` if the
 * query fails (caller should log + continue — delegate-set is not
 * worth aborting a run for).
 */
export async function resolveAgentViewerId(
  token: string,
  linearOrgId: string,
  cache: ViewerCache,
): Promise<string | null> {
  const key = `viewer:${linearOrgId}`;
  try {
    const cached = await cache.get(key);
    if (cached) return cached;
  } catch {
    // KV read failure is non-fatal — fall through to the GraphQL fetch.
  }

  try {
    const res = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
      },
      body: JSON.stringify({ query: VIEWER_QUERY }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { viewer?: { id?: string } };
      errors?: Array<{ message: string }>;
    };
    if (json.errors && json.errors.length > 0) return null;
    const id = json.data?.viewer?.id;
    if (!id) return null;

    try {
      await cache.put(key, id, { expirationTtl: VIEWER_TTL_SECONDS });
    } catch {
      // KV write failure is non-fatal — we still got the id.
    }
    return id;
  } catch {
    return null;
  }
}
