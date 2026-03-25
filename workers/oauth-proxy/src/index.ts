import { PROVIDERS } from "./providers";

export interface Env {
  OAUTH_KV: KVNamespace;
  REDIRECT_URI: string;
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

interface PendingEntry {
  provider: string;
  code_challenge: string;
}

interface TokenEntry {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  code_challenge?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/health") {
      return handleHealth();
    }
    if (request.method === "GET" && path === "/authorize") {
      return handleAuthorize(url, env);
    }
    if (request.method === "GET" && path === "/callback") {
      return handleCallback(url, env);
    }
    if (request.method === "POST" && path === "/token") {
      return handleToken(request, env);
    }

    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};

function handleHealth(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleAuthorize(url: URL, env: Env): Promise<Response> {
  const provider = url.searchParams.get("provider");
  const state = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge");

  if (!provider || !state || !codeChallenge) {
    return new Response(
      JSON.stringify({ error: "missing required params: provider, state, code_challenge" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const providerConfig = PROVIDERS[provider];
  if (!providerConfig) {
    return new Response(
      JSON.stringify({ error: `unsupported provider: ${provider}` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const pending: PendingEntry = { provider, code_challenge: codeChallenge };
  await env.OAUTH_KV.put(`oauth:pending:${state}`, JSON.stringify(pending), {
    expirationTtl: 300,
  });

  const clientId = env[providerConfig.clientIdSecret as keyof Env] as string;
  const redirectUri = env.REDIRECT_URI;

  const authorizeParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    scope: providerConfig.scopes,
  });

  // Linear supports PKCE natively
  if (provider === "linear") {
    authorizeParams.set("code_challenge", codeChallenge);
    authorizeParams.set("code_challenge_method", "S256");
  }

  const authorizeUrl = `${providerConfig.authorizeUrl}?${authorizeParams.toString()}`;
  return Response.redirect(authorizeUrl, 302);
}

async function handleCallback(url: URL, env: Env): Promise<Response> {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");

  if (!state || !code) {
    return new Response(
      JSON.stringify({ error: "missing state or code" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const pendingRaw = await env.OAUTH_KV.get(`oauth:pending:${state}`);
  if (!pendingRaw) {
    return new Response(
      JSON.stringify({ error: "invalid or expired state" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const pending: PendingEntry = JSON.parse(pendingRaw);
  const providerConfig = PROVIDERS[pending.provider];
  if (!providerConfig) {
    return new Response(
      JSON.stringify({ error: "unknown provider in pending entry" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const clientId = env[providerConfig.clientIdSecret as keyof Env] as string;
  const clientSecret = env[providerConfig.clientSecretSecret as keyof Env] as string;
  const redirectUri = env.REDIRECT_URI;

  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const tokenResponse = await fetch(providerConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: tokenParams.toString(),
  });

  if (!tokenResponse.ok) {
    console.error(`Token exchange failed with status ${tokenResponse.status}`);
    return new Response(
      JSON.stringify({ error: "token exchange failed" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const tokens = (await tokenResponse.json()) as Record<string, unknown>;

  if (!tokens.access_token) {
    console.error("Token response missing access_token");
    return new Response(
      JSON.stringify({ error: "invalid token response" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const tokenEntry: TokenEntry = {
    access_token: tokens.access_token as string,
    refresh_token: tokens.refresh_token as string | undefined,
    expires_at: tokens.expires_in
      ? Math.floor(Date.now() / 1000) + (tokens.expires_in as number)
      : undefined,
    scope: tokens.scope as string | undefined,
    code_challenge: pending.code_challenge,
  };

  await env.OAUTH_KV.put(`oauth:token:${state}`, JSON.stringify(tokenEntry), {
    expirationTtl: 60,
  });

  await env.OAUTH_KV.delete(`oauth:pending:${state}`);

  return new Response(COMPLETION_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function handleToken(request: Request, env: Env): Promise<Response> {
  let body: { state?: string; code_verifier?: string };
  try {
    body = (await request.json()) as { state?: string; code_verifier?: string };
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { state, code_verifier } = body;
  if (!state || !code_verifier) {
    return new Response(
      JSON.stringify({ error: "missing required fields: state, code_verifier" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const tokenRaw = await env.OAUTH_KV.get(`oauth:token:${state}`);

  if (tokenRaw) {
    const tokenData: TokenEntry = JSON.parse(tokenRaw);

    // Verify PKCE: SHA-256(code_verifier) must match stored code_challenge
    if (!tokenData.code_challenge) {
      return new Response(
        JSON.stringify({ error: "missing code_challenge in token entry" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const isValid = await verifyPkce(code_verifier, tokenData.code_challenge);
    if (!isValid) {
      return new Response(
        JSON.stringify({ error: "invalid code_verifier" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    // Delete token entry (single-use)
    await env.OAUTH_KV.delete(`oauth:token:${state}`);

    // Return tokens without the code_challenge field
    const { code_challenge: _, ...tokens } = tokenData;
    return new Response(JSON.stringify(tokens), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Check if auth is still pending
  const pendingRaw = await env.OAUTH_KV.get(`oauth:pending:${state}`);
  if (pendingRaw) {
    return new Response(JSON.stringify({ status: "pending" }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Neither token nor pending found — expired
  return new Response(JSON.stringify({ error: "expired or unknown state" }), {
    status: 410,
    headers: { "Content-Type": "application/json" },
  });
}

async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return base64url === codeChallenge;
}

const COMPLETION_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authentication Complete</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authentication complete</h1>
    <p>You can close this tab.</p>
  </div>
</body>
</html>`;
