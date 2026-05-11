/**
 * OAuth flow helpers for two distinct installations of the same
 * Linear OAuth app:
 *
 *   - `actor=app` (agent install) — first-class workspace user the
 *     agent acts as. Required for Agent Session events. Scopes:
 *     `read`, `write`, `app:assignable`, `app:mentionable`.
 *
 *   - `actor=user` (dashboard login) — per-human OAuth used to gate
 *     the dashboard and as the Linear MCP bearer at /run time.
 *     Scopes: `read`, `write` (no `app:*`). Includes refresh tokens
 *     so the workflow can refresh aggressively before each run.
 *
 * Both flows share the same client id/secret and the same token
 * exchange endpoint — only the authorize URL params differ.
 */

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";

export const APP_INSTALL_SCOPES = [
  "read",
  "write",
  "app:assignable",
  "app:mentionable",
] as const;

export const USER_DASHBOARD_SCOPES = ["read", "write"] as const;

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

export interface ViewerProfile {
  id: string;
  email: string | null;
  name: string | null;
  organizationId: string;
  organizationName: string | null;
}

export interface AuthorizationUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: readonly string[];
  /** Pass "app" to install the agent identity; omit for `actor=user`. */
  actor?: "app";
  /** Pass "consent" to force re-consent; omit to let Linear honor a
   *  prior approval. We default the install flow to "consent" since the
   *  scope set changes are explicit and we want the operator to see
   *  them; the user-login flow omits it so re-logins are silent. */
  prompt?: "consent";
}

export class OAuthHelper {
  static generateState(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Build a Linear OAuth authorize URL. Generic over both the
   * `actor=app` install flow and the `actor=user` dashboard login
   * flow — the caller supplies the scope set and whether to force
   * the `actor=app` qualifier.
   */
  static generateAuthorizationUrl(opts: AuthorizationUrlOptions): string {
    const params = new URLSearchParams({
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri,
      response_type: "code",
      scope: opts.scopes.join(","),
      state: opts.state,
    });
    if (opts.actor) params.set("actor", opts.actor);
    if (opts.prompt) params.set("prompt", opts.prompt);
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  /**
   * Back-compat helper for the agent install flow. Equivalent to
   * `generateAuthorizationUrl` with `APP_INSTALL_SCOPES + actor=app + prompt=consent`.
   * Existing callsites keep working.
   */
  static generateAppInstallUrl(
    clientId: string,
    redirectUri: string,
    state: string,
  ): string {
    return OAuthHelper.generateAuthorizationUrl({
      clientId,
      redirectUri,
      state,
      scopes: APP_INSTALL_SCOPES,
      actor: "app",
      prompt: "consent",
    });
  }

  /**
   * User-actor authorize URL for dashboard login. Per-human token
   * doubles as the Linear MCP bearer at /run time.
   */
  static generateUserLoginUrl(
    clientId: string,
    redirectUri: string,
    state: string,
  ): string {
    return OAuthHelper.generateAuthorizationUrl({
      clientId,
      redirectUri,
      state,
      scopes: USER_DASHBOARD_SCOPES,
    });
  }

  static async exchangeCodeForToken(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ): Promise<OAuthTokenResponse> {
    const params = new URLSearchParams({
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      throw new Error(`token_exchange_failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as OAuthTokenResponse;
  }

  /**
   * Exchange a refresh token for a new access/refresh pair. Linear
   * issues fresh refresh tokens on each refresh; the caller must
   * persist whatever Linear returns to D1.
   */
  static async refreshToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string,
  ): Promise<OAuthTokenResponse> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) {
      throw new Error(`token_refresh_failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as OAuthTokenResponse;
  }

  /**
   * Fetch the organization id of the install by querying Linear's
   * `viewer.organization.id` with the just-minted access token. The
   * value is the primary key in our `installations` table.
   */
  static async fetchOrganizationId(accessToken: string): Promise<string> {
    const profile = await OAuthHelper.fetchViewerProfile(accessToken);
    return profile.organizationId;
  }

  /**
   * Fetch the viewer's profile + organization for the dashboard
   * login flow. The id field is the Linear user id; we record it
   * along with email/name so the dashboard can show "Connected as
   * <name>" without re-querying.
   */
  static async fetchViewerProfile(accessToken: string): Promise<ViewerProfile> {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: accessToken.startsWith("Bearer ")
          ? accessToken
          : `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query:
          "query { viewer { id email name organization { id name } } }",
      }),
    });
    if (!res.ok) {
      throw new Error(`viewer_query_failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      data?: {
        viewer?: {
          id?: string;
          email?: string | null;
          name?: string | null;
          organization?: { id?: string; name?: string | null };
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `viewer_query_errors: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }
    const viewer = json.data?.viewer;
    const orgId = viewer?.organization?.id;
    const linearUserId = viewer?.id;
    if (!orgId || !linearUserId) {
      throw new Error("viewer_query_missing_fields");
    }
    return {
      id: linearUserId,
      email: viewer?.email ?? null,
      name: viewer?.name ?? null,
      organizationId: orgId,
      organizationName: viewer?.organization?.name ?? null,
    };
  }
}
