import { Hono } from "hono";
import type { Env } from "../index";
import { readSessionFromRequest } from "../lib/session-cookie";
import { InstallationStore } from "../lib/store";

/**
 * Symphony GitHub App install routes.
 *
 *   GET /github/install/start    — auth-gated (dashboard cookie).
 *                                  Builds an install URL with
 *                                  `state=<orgId>` (HMAC-signed) and
 *                                  redirects the operator to GitHub's
 *                                  consent screen.
 *
 *   GET /github/install/callback — GitHub redirects here after the
 *                                  install succeeds with
 *                                  `installation_id` + our signed
 *                                  `state`. We verify the state,
 *                                  write the install id to D1, and
 *                                  redirect back into the dashboard.
 *
 * State signing reuses the dashboard session HMAC secret
 * (`DASHBOARD_COOKIE_SECRET`) rather than introducing a third Worker
 * secret. State is short-lived (5 min) and binds the orgId to the
 * cookie's user — so a leaked install URL can't be replayed against
 * a different org.
 */

const STATE_TTL_SECONDS = 5 * 60;

export function buildGitHubInstallRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/github/install/start", async (c) => {
    const session = await readSessionFromRequest(c.env, c.req.raw);
    if (!session) {
      // Redirect through dashboard login first; the dashboard will
      // bring the user back here after auth.
      return c.redirect(`${c.env.URL}/oauth/user/authorize`);
    }
    if (!c.env.GITHUB_APP_INSTALL_URL) {
      return c.json({ error: "github_app_install_url_unset" }, 500);
    }
    if (!c.env.DASHBOARD_COOKIE_SECRET) {
      return c.json({ error: "dashboard_cookie_secret_unset" }, 500);
    }

    const state = await signInstallState(
      c.env.DASHBOARD_COOKIE_SECRET,
      session.oid,
      session.uid,
    );
    const installUrl = new URL(c.env.GITHUB_APP_INSTALL_URL);
    installUrl.searchParams.set("state", state);
    return c.redirect(installUrl.toString());
  });

  app.get("/github/install/callback", async (c) => {
    const session = await readSessionFromRequest(c.env, c.req.raw);
    if (!session) {
      return c.redirect(`${c.env.URL}/oauth/user/authorize`);
    }
    if (!c.env.DASHBOARD_COOKIE_SECRET) {
      return c.json({ error: "dashboard_cookie_secret_unset" }, 500);
    }

    const installationIdRaw = c.req.query("installation_id");
    const state = c.req.query("state");
    const setupAction = c.req.query("setup_action"); // "install" | "update"
    if (!installationIdRaw || !state) {
      return c.json({ error: "missing_parameters" }, 400);
    }
    const installationId = parseInt(installationIdRaw, 10);
    if (!Number.isFinite(installationId) || installationId <= 0) {
      return c.json({ error: "invalid_installation_id" }, 400);
    }

    const parsedState = await verifyInstallState(
      c.env.DASHBOARD_COOKIE_SECRET,
      state,
    );
    if (!parsedState) {
      return c.json({ error: "invalid_state" }, 400);
    }
    if (parsedState.oid !== session.oid || parsedState.uid !== session.uid) {
      // State must be bound to the cookie's user/org — defense against
      // a replay where someone hijacks the install URL.
      return c.json({ error: "state_mismatch" }, 400);
    }

    await new InstallationStore(c.env.DB).setGithubAppInstallationId(
      parsedState.oid,
      installationId,
    );

    const dest = `${c.env.URL}/dashboard?gh_installed=1${
      setupAction ? `&setup_action=${encodeURIComponent(setupAction)}` : ""
    }`;
    return c.redirect(dest);
  });

  return app;
}

interface InstallState {
  oid: string;
  uid: string;
  exp: number;
}

async function signInstallState(
  secret: string,
  organizationId: string,
  userId: string,
): Promise<string> {
  const payload: InstallState = {
    oid: organizationId,
    uid: userId,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
  };
  const json = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(json));
  const sig = await hmac(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

async function verifyInstallState(
  secret: string,
  raw: string,
): Promise<InstallState | null> {
  const dot = raw.indexOf(".");
  if (dot === -1) return null;
  const payloadB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = await hmac(secret, payloadB64);
  if (!constantTimeEqual(sig, expected)) return null;

  try {
    const json = new TextDecoder().decode(base64UrlDecode(payloadB64));
    const parsed = JSON.parse(json) as Partial<InstallState>;
    if (
      typeof parsed.oid !== "string" ||
      typeof parsed.uid !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed as InstallState;
  } catch {
    return null;
  }
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)),
  );
  return base64UrlEncode(sig);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
