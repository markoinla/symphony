/**
 * Refresh the `linear_agent_installs.access_token` for a tenant.
 *
 * The install's `actor=app` token is what we use to post agent
 * activities, transition issues, create attachments, and mint agent
 * sessions on Linear's side. Linear's OAuth tokens expire (typically
 * within a day or two). We don't track the explicit `expires_at` for
 * the install row, so the only failure signal is a 401 from a Linear
 * GraphQL call — too late, inside a workflow step that may already
 * have retried the bad call.
 *
 * This helper does a proactive `grant_type=refresh_token` exchange:
 *   1. Look up the install by `organizations.id`.
 *   2. Call Linear's OAuth `/token` endpoint with the stored
 *      `refresh_token` and our `LINEAR_CLIENT_ID` + `LINEAR_CLIENT_SECRET`.
 *   3. Persist the new `access_token` (and new `refresh_token` if Linear
 *      rotated it) back into `linear_agent_installs`.
 *   4. Return the fresh access token.
 *
 * Returns `null` if anything fails (missing install, missing client
 * credentials, refresh rejected). Callers should fall back to the
 * existing stored token when null — degraded but better than no run.
 */

import type { Env } from "../index";
import { LinearAgentInstallStore } from "./store";
import { OAuthRefreshError, refreshOAuthToken } from "./token-refresh";

export interface RefreshInstallTokenResult {
  accessToken: string;
  refreshed: boolean;
}

export async function refreshInstallToken(
  env: Pick<Env, "DB" | "LINEAR_CLIENT_ID" | "LINEAR_CLIENT_SECRET">,
  organizationId: string,
): Promise<RefreshInstallTokenResult | null> {
  if (!env.LINEAR_CLIENT_ID || !env.LINEAR_CLIENT_SECRET) {
    console.warn("install_token_refresh_missing_oauth_client");
    return null;
  }

  const installs = new LinearAgentInstallStore(env.DB);
  const install = await installs.getByOrgId(organizationId);
  if (!install) {
    console.warn("install_token_refresh_no_install", organizationId);
    return null;
  }
  if (!install.refresh_token) {
    console.warn("install_token_refresh_no_refresh_token", organizationId);
    return null;
  }

  try {
    const result = await refreshOAuthToken({
      refreshToken: install.refresh_token,
      clientId: env.LINEAR_CLIENT_ID,
      clientSecret: env.LINEAR_CLIENT_SECRET,
    });
    await installs.refreshToken(
      install.id,
      result.accessToken,
      result.refreshToken,
    );
    return { accessToken: result.accessToken, refreshed: true };
  } catch (e) {
    if (e instanceof OAuthRefreshError) {
      console.error(
        "install_token_refresh_failed",
        JSON.stringify({
          organizationId,
          status: e.status,
          body: e.body.slice(0, 200),
        }),
      );
    } else {
      console.error(
        "install_token_refresh_error",
        e instanceof Error ? e.message : String(e),
      );
    }
    return null;
  }
}
