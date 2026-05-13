/**
 * One thin wrapper around `POST https://api.linear.app/graphql` that
 * every helper in `lib/{activities,linear-mutations,agent-viewer,issues}.ts`
 * funnels through.
 *
 * Centralizing it gets us three things in one place:
 *
 *   1. **Reactive 401 → refresh → retry.** Callers pass an optional
 *      `onTokenExpired` callback. On HTTP 401 the helper calls it once,
 *      uses the returned access_token to re-issue the request, and
 *      returns the result. A single retry is enough to ride out a
 *      mid-session OAuth token expiry; if the second request still
 *      401s, that's terminal (caller's `accessToken` was bad for
 *      reasons other than expiry — bubble the error up).
 *
 *   2. **Consistent envelope handling.** Linear returns 200 + `errors`
 *      for GraphQL-level failures (mutation rejected, unknown field).
 *      We surface those uniformly as thrown Errors prefixed with the
 *      operation name, so call sites get one error path to catch.
 *
 *   3. **One Bearer-prefix normalizer.** Most callers pass raw tokens,
 *      a few pass `Bearer xyz`. Doing the check here keeps each
 *      file's per-mutation wrapper trivial.
 *
 * The shape mirrors `SymphonyElixir.Linear.AgentAPI.agent_graphql_with_retry`
 * (lib/symphony_elixir/linear/agent_api.ex:141-201) with the same
 * `auth_retry?` single-shot semantics.
 */

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export type LinearTokenRefresher = () => Promise<string | null>;

export interface LinearGraphQLArgs {
  /** Bearer token (with or without the "Bearer " prefix). */
  accessToken: string;
  query: string;
  variables?: Record<string, unknown>;
  /**
   * Operation label used in thrown error messages. Pick something
   * grep-able (e.g. "agentActivityCreate", "issueUpdate").
   */
  opName: string;
  /**
   * Called on the first 401 to obtain a fresh token. Return `null` to
   * skip the retry (helper will throw on the original 401 response).
   */
  onTokenExpired?: LinearTokenRefresher;
}

export async function linearGraphQL<T>(args: LinearGraphQLArgs): Promise<T> {
  let token = args.accessToken;
  let res = await postWithToken(token, args.query, args.variables);
  if (res.status === 401 && args.onTokenExpired) {
    const refreshed = await args.onTokenExpired();
    if (refreshed) {
      token = refreshed;
      res = await postWithToken(token, args.query, args.variables);
    }
  }
  if (!res.ok) {
    throw new Error(
      `${args.opName} http ${res.status}: ${(await res.text()).slice(0, 500)}`,
    );
  }
  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (json.errors && json.errors.length > 0) {
    throw new Error(
      `${args.opName} graphql: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return (json.data ?? ({} as T)) as T;
}

async function postWithToken(
  token: string,
  query: string,
  variables: Record<string, unknown> | undefined,
): Promise<Response> {
  return fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
}
