/**
 * GitHub App authentication for minting per-org installation tokens.
 *
 * Flow (standard GitHub App auth dance):
 *   1. Sign a JWT with the App's RSA private key (RS256).
 *   2. Exchange it at POST /app/installations/<id>/access_tokens
 *      for a ~1h installation token scoped to the org's repos.
 *   3. Cache the token in-memory keyed by installationId with
 *      TTL = expires_at - 5min so we don't hit GitHub on every run.
 *
 * The private key is stored as a Workers secret (PEM format) and
 * the App ID is stored as a separate secret. Both are set via:
 *   wrangler secret put GITHUB_APP_ID
 *   wrangler secret put GITHUB_APP_PRIVATE_KEY
 */

const GITHUB_API = "https://api.github.com";

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<number, CachedToken>();

const CACHE_MARGIN_MS = 5 * 60 * 1000;

export async function mintInstallationToken(
  installationId: number,
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const jwt = await createAppJwt(appId, privateKeyPem);

  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "symphony-github-app",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `github_app_token_exchange_failed: ${res.status} ${body.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as {
    token: string;
    expires_at: string;
  };

  const expiresAt = new Date(json.expires_at).getTime() - CACHE_MARGIN_MS;
  tokenCache.set(installationId, { token: json.token, expiresAt });

  return json.token;
}

/**
 * Create a short-lived JWT for GitHub App authentication.
 *
 * GitHub requires:
 *   - iss: the App ID
 *   - iat: issued at (backdate 60s for clock skew)
 *   - exp: expiration (max 10 minutes; we use 9 minutes)
 *   - alg: RS256
 */
async function createAppJwt(
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: appId,
    iat: now - 60,
    exp: now + 9 * 60,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importPrivateKey(privateKeyPem);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput),
    ),
  );

  return `${signingInput}.${base64UrlEncodeBytes(signature)}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  const binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64UrlEncode(str: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(str));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
