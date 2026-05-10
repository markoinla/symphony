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

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
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
}
