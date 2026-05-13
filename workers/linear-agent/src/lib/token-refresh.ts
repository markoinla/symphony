/**
 * Generic OAuth2 token refresh helper.
 *
 * Designed for Linear's OAuth but provider-agnostic: any service that
 * supports the standard `grant_type=refresh_token` flow works with
 * the same interface. Future MCP servers (GitHub, Notion, etc.) can
 * reuse this by passing their own token URL and client credentials.
 */

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

export interface OAuthRefreshParams {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  tokenUrl?: string;
}

export interface OAuthRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  /** ISO timestamp — convenient for the `tokenNeedsRefresh` helper. */
  expiresAt: string | null;
  /** Unix seconds — what we persist on `linear_agent_installs.expires_at`. */
  expiresAtUnix: number | null;
}

export class OAuthRefreshError extends Error {
  /**
   * True when Linear returned `error: invalid_grant` or
   * `error: unauthorized_client` on the OAuth token endpoint —
   * the refresh_token is permanently dead and the user must reconnect.
   * Mirrors `SymphonyElixir.Linear.OAuth.Refresher.invalid_grant?/2`.
   */
  public readonly invalidGrant: boolean;

  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`oauth_refresh_failed: ${status} ${body}`);
    this.name = "OAuthRefreshError";
    this.invalidGrant = isInvalidGrant(status, body);
  }
}

function isInvalidGrant(status: number, body: string): boolean {
  if (status !== 400 && status !== 401) return false;
  // Linear's token endpoint returns JSON; if for some reason the body
  // is not JSON we fall back to substring matching so the classification
  // still fires on the common case.
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return parsed.error === "invalid_grant" || parsed.error === "unauthorized_client";
  } catch {
    return /\b(invalid_grant|unauthorized_client)\b/.test(body);
  }
}

export async function refreshOAuthToken(
  params: OAuthRefreshParams,
): Promise<OAuthRefreshResult> {
  const tokenUrl = params.tokenUrl ?? LINEAR_TOKEN_URL;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new OAuthRefreshError(res.status, text);
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json.access_token) {
    throw new OAuthRefreshError(0, "missing_access_token_in_response");
  }

  const expiresAtMs = json.expires_in ? Date.now() + json.expires_in * 1000 : null;
  const expiresAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;
  const expiresAtUnix = expiresAtMs ? Math.floor(expiresAtMs / 1000) : null;

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt,
    expiresAtUnix,
  };
}

const DEFAULT_SAFETY_MARGIN_MS = 5 * 60 * 1000;

export function tokenNeedsRefresh(
  expiresAt: string | null,
  runTimeoutMs: number,
  safetyMarginMs: number = DEFAULT_SAFETY_MARGIN_MS,
): boolean {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt).getTime();
  if (isNaN(expiry)) return false;
  return expiry < Date.now() + runTimeoutMs + safetyMarginMs;
}

/**
 * Unix-seconds variant of `tokenNeedsRefresh`. Matches the column type
 * on `linear_agent_installs.expires_at` so callers can pass the row
 * directly without converting through Date.
 *
 * Conservative on unknown expiries: returns `true` when `expiresAt` is
 * null so legacy install rows (pre migration 0006) refresh on their
 * next use instead of riding a possibly-stale stored token to a 401.
 */
export function tokenNeedsRefreshUnix(
  expiresAt: number | null,
  runTimeoutMs: number,
  safetyMarginMs: number = DEFAULT_SAFETY_MARGIN_MS,
): boolean {
  if (expiresAt === null) return true;
  return expiresAt * 1000 < Date.now() + runTimeoutMs + safetyMarginMs;
}
