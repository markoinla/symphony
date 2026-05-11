/**
 * Assemble the per-tenant `credentials` block sent on every /run.
 *
 * Inputs come from three places:
 *   1. `installations` row → GitHub App installation id (mint token).
 *   2. `users` row → Linear user OAuth token (refresh aggressively).
 *   3. `org_credentials` rows → BYO Anthropic/OpenAI/CF Workers AI keys
 *      (decrypt via envelope encryption).
 *
 * The Workflow drops in this output as `credentials` on the
 * DispatcherClient `runStream` args, plus rewrites `repoUrl` to embed
 * the GitHub token for the dispatcher's `git clone` step.
 *
 * Everything is best-effort: missing pieces degrade gracefully rather
 * than failing the run. Missing GH App install → no PR push (legacy
 * behavior). Missing Linear user token → no Linear MCP server. Missing
 * BYO key → caller relies on engine defaults (e.g. Cloudflare Workers
 * AI which is itself a tenant-scoped env-injected lane).
 */

import { decryptForOrg, type KekEnv } from "./crypto";
import {
  GitHubAppError,
  mintInstallationToken,
  type GitHubAppEnv,
} from "./github-app";
import {
  pickBestUserToken,
  type TokenRefreshEnv,
} from "./token-refresh";
import {
  InstallationStore,
  OrgCredentialStore,
} from "./store";

const LINEAR_MCP_URL = "https://mcp.linear.app/sse";

export interface AssembleEnv extends KekEnv, GitHubAppEnv, TokenRefreshEnv {}

export interface AssembledRun {
  /**
   * Repo URL rewritten to embed the GitHub installation token for
   * HTTPS auth. Falls back to the original URL when no GH token is
   * available (`commitAndPush` will skip if there's no token in the
   * credentials block AND no DISPATCH_GITHUB_TOKEN env fallback).
   */
  repoUrl: string;
  /** Credentials block to forward as-is to the dispatcher. */
  credentials: import("./dispatcher").RunCredentials;
}

/** BYO kinds we know how to map to env vars. */
const ENV_BYO_KIND_TO_FIELD: Record<
  string,
  keyof import("./dispatcher").RunCredentials
> = {
  anthropic_api_key: "anthropic_api_key",
  openai_api_key: "openai_api_key",
  cloudflare_account_id: "cloudflare_account_id",
  cloudflare_api_token: "cloudflare_api_token",
};

export async function assembleRunCredentials(args: {
  env: AssembleEnv;
  organizationId: string;
  triggeredByLinearUserId: string | null;
  /** Used to size the user-token refresh window so the token outlives the run. */
  runTimeoutMs: number;
  repoUrl: string;
}): Promise<AssembledRun> {
  const { env, organizationId, triggeredByLinearUserId, runTimeoutMs, repoUrl } =
    args;

  const credentials: import("./dispatcher").RunCredentials = {};

  // ----- GitHub App installation token -----
  const install = await new InstallationStore(env.DB).get(organizationId);
  let githubToken: string | null = null;
  if (install?.github_app_installation_id) {
    try {
      githubToken = await mintInstallationToken(
        env,
        install.github_app_installation_id,
      );
      credentials.github_token = githubToken;
    } catch (e) {
      console.error(
        "github_app_mint_failed",
        JSON.stringify({
          org_id: organizationId,
          installation_id: install.github_app_installation_id,
          error: e instanceof GitHubAppError ? `${e.stage}:${e.message}` : String(e),
        }),
      );
    }
  }

  // ----- Linear user OAuth token (MCP bearer) -----
  const userToken = await pickBestUserToken(
    env,
    organizationId,
    triggeredByLinearUserId,
    runTimeoutMs,
  );
  if (userToken) {
    credentials.mcp_servers = [
      {
        name: "linear",
        url: LINEAR_MCP_URL,
        token: userToken.accessToken,
      },
    ];
    console.log(
      "linear_mcp_attached",
      JSON.stringify({
        org_id: organizationId,
        user_source: userToken.source,
        // Don't log the token; user id is enough to correlate later.
        user_id: userToken.userId,
      }),
    );
  }

  // ----- BYO API keys from org_credentials -----
  const creds = new OrgCredentialStore(env.DB);
  for (const [kind, field] of Object.entries(ENV_BYO_KIND_TO_FIELD)) {
    const row = await creds.get(organizationId, kind);
    if (!row) continue;
    try {
      const plaintext = await decryptForOrg(env, row);
      // Type assertion: `field` is the union of allowed env keys.
      (credentials as Record<string, string>)[field] = plaintext;
    } catch (e) {
      console.error(
        "org_credential_decrypt_failed",
        JSON.stringify({
          org_id: organizationId,
          kind,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  // ----- Rewrite repo URL with GH installation token -----
  const finalRepoUrl = githubToken
    ? rewriteRepoUrlWithToken(repoUrl, githubToken)
    : repoUrl;

  return { repoUrl: finalRepoUrl, credentials };
}

/**
 * Rewrite `https://github.com/owner/repo[.git]` to
 * `https://x-access-token:<token>@github.com/owner/repo[.git]` for
 * HTTPS auth on `git clone` inside the dispatcher.
 *
 * The dispatcher's repo-URL validator (`run.ts#parseRepoUrl`) refuses
 * shell metachars but accepts `@` and any non-meta char, so this is
 * safe to send. We never log the rewritten URL — it contains the
 * token. The token is also passed separately in `credentials.github_token`
 * so `commitAndPush` doesn't have to re-derive it from the URL.
 */
export function rewriteRepoUrlWithToken(repoUrl: string, token: string): string {
  if (!repoUrl.startsWith("https://")) return repoUrl;
  // Avoid double-rewriting if the caller somehow passed an already-authed URL.
  if (repoUrl.includes("x-access-token:")) return repoUrl;
  return repoUrl.replace(
    /^https:\/\//,
    `https://x-access-token:${encodeURIComponent(token)}@`,
  );
}
