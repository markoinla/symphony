interface Env {
  OAUTH_KV: KVNamespace;
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  LINEAR_WEBHOOK_SIGNING_SECRET: string;
  REGISTRATION_SECRET: string;
}

type Provider = "linear" | "github";

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  actor?: string;
  clientId: string;
  clientSecret: string;
}

interface PendingEntry {
  provider: Provider;
  code_challenge: string;
}

interface TokenEntry {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  code_challenge: string;
}

interface InstanceEntry {
  instance_url: string;
  registered_at: string;
}

/**
 * Convert bare-IP URLs to sslip.io hostnames so Cloudflare Workers' fetch()
 * can reach them (Workers block direct IP access with error 1003).
 * Domain-name URLs pass through unchanged.
 */
function resolveInstanceUrl(url: string): string {
  const parsed = new URL(url);
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname)) {
    parsed.hostname = parsed.hostname.replaceAll(".", "-") + ".sslip.io";
  }
  return parsed.toString().replace(/\/$/, "");
}

const PENDING_TTL = 300; // 5 minutes
const TOKEN_TTL = 60; // 60 seconds

const PROVIDERS: Record<Provider, (env: Env) => ProviderConfig> = {
  linear: (env) => ({
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: "write,read,app:assignable,app:mentionable",
    actor: "app",
    clientId: env.LINEAR_CLIENT_ID,
    clientSecret: env.LINEAR_CLIENT_SECRET,
  }),
  github: (env) => ({
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: "repo",
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
  }),
};

function isProvider(value: string): value is Provider {
  return value in PROVIDERS;
}

async function verifyS256(
  codeVerifier: string,
  codeChallenge: string,
): Promise<boolean> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const computed = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return computed === codeChallenge;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/health":
        return Response.json({ ok: true });
      case "/authorize":
        return handleAuthorize(url, env);
      case "/callback":
        return handleCallback(url, env);
      case "/token":
        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        return handleToken(request, env);
      case "/register":
        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        return handleRegister(request, env);
      case "/deregister":
        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        return handleDeregister(request, env);
      case "/webhooks/linear":
        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        return handleWebhookLinear(request, env);
      case "/ping-instance":
        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        return handlePingInstance(request, env);
      default:
        return new Response("Not Found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Start an OAuth flow. Stores PKCE challenge in KV and redirects to provider.
 *
 * Query params: provider, state, code_challenge
 */
async function handleAuthorize(url: URL, env: Env): Promise<Response> {
  const provider = url.searchParams.get("provider");
  const state = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge");

  if (!provider || !state || !codeChallenge) {
    return Response.json(
      { error: "missing required parameters: provider, state, code_challenge" },
      { status: 400 },
    );
  }

  if (!isProvider(provider)) {
    return Response.json(
      { error: `unsupported provider: ${provider}` },
      { status: 400 },
    );
  }

  const config = PROVIDERS[provider](env);

  await env.OAUTH_KV.put(
    `oauth:pending:${state}`,
    JSON.stringify({ provider, code_challenge: codeChallenge } satisfies PendingEntry),
    { expirationTtl: PENDING_TTL },
  );

  const authUrl = new URL(config.authorizeUrl);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", `${url.origin}/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", config.scopes);
  authUrl.searchParams.set("state", state);
  if (config.actor) {
    authUrl.searchParams.set("actor", config.actor);
  }

  return new Response(null, {
    status: 302,
    headers: { Location: authUrl.toString() },
  });
}

/**
 * OAuth callback from the provider. Exchanges code for tokens and stores them
 * in KV for the Symphony instance to poll via POST /token.
 */
async function handleCallback(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return errorPage(`Authorization failed: ${error}`);
  }

  if (!code || !state) {
    return errorPage("Missing code or state parameter");
  }

  const raw = await env.OAUTH_KV.get(`oauth:pending:${state}`);
  if (!raw) {
    return errorPage("Invalid or expired authorization state");
  }

  const pending = JSON.parse(raw) as PendingEntry;
  const config = PROVIDERS[pending.provider](env);

  const tokenRes = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: `${url.origin}/callback`,
      code,
    }),
  });

  if (!tokenRes.ok) {
    return errorPage("Token exchange failed");
  }

  const tokens = (await tokenRes.json()) as Record<string, unknown>;

  const tokenEntry: TokenEntry = {
    access_token: tokens.access_token as string,
    refresh_token: (tokens.refresh_token as string | undefined) ?? undefined,
    expires_at: typeof tokens.expires_in === "number"
      ? Math.floor(Date.now() / 1000) + tokens.expires_in
      : undefined,
    scope: (tokens.scope as string | undefined) ?? undefined,
    code_challenge: pending.code_challenge,
  };

  await Promise.all([
    env.OAUTH_KV.put(
      `oauth:token:${state}`,
      JSON.stringify(tokenEntry),
      { expirationTtl: TOKEN_TTL },
    ),
    env.OAUTH_KV.delete(`oauth:pending:${state}`),
  ]);

  return new Response(COMPLETION_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Poll for completed OAuth tokens. Validates PKCE S256 before returning.
 *
 * Returns: 200 with tokens, 202 if auth still pending, 401 if bad verifier, 410 if expired.
 */
async function handleToken(request: Request, env: Env): Promise<Response> {
  let body: { state?: string; code_verifier?: string };
  try {
    body = (await request.json()) as { state?: string; code_verifier?: string };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.state || !body.code_verifier) {
    return Response.json(
      { error: "missing required fields: state, code_verifier" },
      { status: 400 },
    );
  }

  const { state, code_verifier } = body;

  // Check for completed tokens
  const tokenRaw = await env.OAUTH_KV.get(`oauth:token:${state}`);
  if (tokenRaw) {
    const entry = JSON.parse(tokenRaw) as TokenEntry;

    if (!(await verifyS256(code_verifier, entry.code_challenge))) {
      return Response.json({ error: "invalid code_verifier" }, { status: 401 });
    }

    // Single-use: delete after successful retrieval
    await env.OAUTH_KV.delete(`oauth:token:${state}`);

    return Response.json({
      access_token: entry.access_token,
      refresh_token: entry.refresh_token,
      expires_at: entry.expires_at,
      scope: entry.scope,
    });
  }

  // Auth still in progress
  const pendingRaw = await env.OAUTH_KV.get(`oauth:pending:${state}`);
  if (pendingRaw) {
    return Response.json({ status: "pending" }, { status: 202 });
  }

  // Expired or never existed
  return Response.json({ error: "expired or unknown state" }, { status: 410 });
}

/**
 * Register a Symphony instance URL for webhook forwarding.
 *
 * Authenticated via REGISTRATION_SECRET in the Authorization header.
 * Body: { instance_url, linear_org_id }
 */
async function handleRegister(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${env.REGISTRATION_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { instance_url?: string; linear_org_id?: string };
  try {
    body = (await request.json()) as { instance_url?: string; linear_org_id?: string };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.instance_url || !body.linear_org_id) {
    return Response.json(
      { error: "missing required fields: instance_url, linear_org_id" },
      { status: 400 },
    );
  }

  const entry: InstanceEntry = {
    instance_url: body.instance_url,
    registered_at: new Date().toISOString(),
  };

  await env.OAUTH_KV.put(
    `instance:${body.linear_org_id}`,
    JSON.stringify(entry),
  );

  return Response.json({ ok: true, linear_org_id: body.linear_org_id });
}

/**
 * Remove a registered instance, stopping webhook forwarding.
 *
 * Authenticated via REGISTRATION_SECRET. Body: { linear_org_id }
 */
async function handleDeregister(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${env.REGISTRATION_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { linear_org_id?: string };
  try {
    body = (await request.json()) as { linear_org_id?: string };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.linear_org_id) {
    return Response.json(
      { error: "missing required field: linear_org_id" },
      { status: 400 },
    );
  }

  await env.OAUTH_KV.delete(`instance:${body.linear_org_id}`);

  return Response.json({ ok: true, linear_org_id: body.linear_org_id });
}

/**
 * Verify HMAC-SHA256 signature from Linear webhook.
 */
async function verifyLinearSignature(
  body: ArrayBuffer,
  signature: string,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const computed = await crypto.subtle.sign("HMAC", key, body);
  const expected = new Uint8Array(computed);

  // Signature from Linear is hex-encoded
  const received = hexToBytes(signature);
  if (!received || received.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    if (isNaN(byte)) return null;
    bytes[i / 2] = byte;
  }
  return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i]! ^ b[i]!;
  }
  return result === 0;
}

/**
 * Receive a Linear webhook, verify its signature, and forward to the
 * registered Symphony instance. Always returns 200 to Linear to prevent
 * retry storms.
 */
async function handleWebhookLinear(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("Linear-Signature");
  if (!signature) {
    console.error("webhook: missing Linear-Signature header");
    return Response.json({ ok: true });
  }

  const rawBody = await request.arrayBuffer();

  if (!(await verifyLinearSignature(rawBody, signature, env.LINEAR_WEBHOOK_SIGNING_SECRET))) {
    console.error("webhook: invalid signature");
    return Response.json({ ok: true });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>;
  } catch {
    console.error("webhook: invalid JSON body");
    return Response.json({ ok: true });
  }

  const orgId = payload.organizationId as string | undefined;
  if (!orgId) {
    console.error("webhook: missing organizationId in payload");
    return Response.json({ ok: true });
  }

  const instanceRaw = await env.OAUTH_KV.get(`instance:${orgId}`);
  if (!instanceRaw) {
    console.error(`webhook: no registered instance for org ${orgId}`);
    return Response.json({ ok: true });
  }

  const instance = JSON.parse(instanceRaw) as InstanceEntry;

  try {
    await fetch(`${resolveInstanceUrl(instance.instance_url)}/api/v1/webhooks/linear`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Signature": signature,
      },
      body: rawBody,
    });
  } catch (err) {
    console.error(`webhook: failed to forward to ${instance.instance_url}:`, err);
  }

  return Response.json({ ok: true });
}

/**
 * Ping a registered instance to verify webhook forwarding will work.
 * Authenticated via REGISTRATION_SECRET. Body: { linear_org_id }
 *
 * The proxy looks up the registered instance URL and tries to reach
 * its health endpoint, returning the result.
 */
async function handlePingInstance(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${env.REGISTRATION_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { linear_org_id?: string };
  try {
    body = (await request.json()) as { linear_org_id?: string };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.linear_org_id) {
    return Response.json(
      { error: "missing required field: linear_org_id" },
      { status: 400 },
    );
  }

  const instanceRaw = await env.OAUTH_KV.get(`instance:${body.linear_org_id}`);
  if (!instanceRaw) {
    return Response.json({
      ok: false,
      registered: false,
      error: "No instance registered for this organization.",
    });
  }

  const instance = JSON.parse(instanceRaw) as InstanceEntry;

  try {
    const res = await fetch(`${resolveInstanceUrl(instance.instance_url)}/healthz`, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      return Response.json({
        ok: true,
        registered: true,
        instance_url: instance.instance_url,
      });
    }

    let body = "";
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }

    return Response.json({
      ok: false,
      registered: true,
      instance_url: instance.instance_url,
      error: `Instance returned HTTP ${res.status}`,
      response_body: body.slice(0, 500),
      response_server: res.headers.get("server"),
    });
  } catch (err) {
    return Response.json({
      ok: false,
      registered: true,
      instance_url: instance.instance_url,
      error: `Could not reach instance: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function errorPage(message: string): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Authentication Error</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0">
  <div style="text-align:center">
    <h1>Authentication Error</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`,
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

const COMPLETION_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Authentication Complete</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0">
  <div style="text-align:center">
    <h1>Authentication complete</h1>
    <p>You can close this tab.</p>
  </div>
</body>
</html>`;
