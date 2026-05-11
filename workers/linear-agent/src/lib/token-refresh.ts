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
  expiresAt: string | null;
}

export class OAuthRefreshError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`oauth_refresh_failed: ${status} ${body}`);
    this.name = "OAuthRefreshError";
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

  const expiresAt = json.expires_in
    ? new Date(Date.now() + json.expires_in * 1000).toISOString()
    : null;

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt,
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
