/**
 * OAuth flow helpers for installing the agent into a Linear workspace
 * with `actor=app` (so the agent appears as its own first-class user).
 *
 * Adapted from linear/linear-agent-demo. Two differences:
 *   1. We request the `app:assignable` and `app:mentionable` scopes that
 *      the Agent Session API requires — the demo's scope set was for the
 *      older AppUserNotification flow.
 *   2. We expose `state` generation as a deterministic-via-crypto helper
 *      so tests can stub it.
 */

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";

const REQUIRED_SCOPES = [
  "read",
  "write",
  "app:assignable",
  "app:mentionable",
] as const;

const USER_SCOPES = ["read", "write"] as const;

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface UserOAuthTokenResponse extends OAuthTokenResponse {
  refresh_token?: string;
}

export interface ViewerInfo {
  id: string;
  email: string;
  name: string;
  organizationId: string;
}

export class OAuthHelper {
  static generateState(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  static generateAuthorizationUrl(
    clientId: string,
    redirectUri: string,
    state: string,
  ): string {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: REQUIRED_SCOPES.join(","),
      state,
      // `actor=app` makes the install a first-class workspace user the
      // agent acts as. This is what enables Agent Session events.
      actor: "app",
      prompt: "consent",
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  static generateUserAuthorizationUrl(
    clientId: string,
    redirectUri: string,
    state: string,
  ): string {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: USER_SCOPES.join(","),
      state,
      prompt: "consent",
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
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
   * Fetch the organization id of the install by querying Linear's
   * `viewer.organization.id` with the just-minted access token. The
   * value is the primary key in our `installations` table.
   */
  static async fetchOrganizationId(accessToken: string): Promise<string> {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: accessToken.startsWith("Bearer ")
          ? accessToken
          : `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query: "query { viewer { organization { id } } }",
      }),
    });
    if (!res.ok) {
      throw new Error(`viewer_query_failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      data?: { viewer?: { organization?: { id?: string } } };
      errors?: Array<{ message: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `viewer_query_errors: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }
    const orgId = json.data?.viewer?.organization?.id;
    if (!orgId) {
      throw new Error("viewer_query_missing_organization_id");
    }
    return orgId;
  }

  static async fetchViewer(accessToken: string): Promise<ViewerInfo> {
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
          "query { viewer { id email name organization { id } } }",
      }),
    });
    if (!res.ok) {
      throw new Error(`viewer_query_failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      data?: {
        viewer?: {
          id?: string;
          email?: string;
          name?: string;
          organization?: { id?: string };
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
    if (!viewer?.id || !viewer.organization?.id) {
      throw new Error("viewer_query_missing_fields");
    }
    return {
      id: viewer.id,
      email: viewer.email ?? "",
      name: viewer.name ?? "",
      organizationId: viewer.organization.id,
    };
  }
}
