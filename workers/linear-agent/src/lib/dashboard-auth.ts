import type { Context } from "hono";
import type { Env } from "../index";
import { UserStore } from "./store";

export interface DashboardUser {
  linearUserId: string;
  organizationId: string;
  email: string | null;
  name: string | null;
}

export async function requireDashboardAuth(
  c: Context<{ Bindings: Env }>,
): Promise<DashboardUser | null> {
  const sessionCookie = getCookie(c, "dashboard_session");
  if (!sessionCookie) {
    return null;
  }

  const userId = await verifySignedCookie(
    sessionCookie,
    c.env.LINEAR_CLIENT_SECRET,
  );
  if (!userId) {
    return null;
  }

  try {
    const store = new UserStore(c.env.DB);
    const user = await store.getByLinearUserId(userId);
    if (!user) {
      return null;
    }

    return {
      linearUserId: user.linear_user_id,
      organizationId: user.organization_id,
      email: user.email,
      name: user.name,
    };
  } catch (e) {
    console.error(
      "auth_lookup_error",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

function getCookie(c: Context, name: string): string | undefined {
  const cookieHeader = c.req.header("cookie");
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return undefined;
}

async function hmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signCookieValue(
  value: string,
  secret: string,
): Promise<string> {
  const key = await hmacKey(secret, "sign");
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${value}.${hex}`;
}

async function verifySignedCookie(
  cookie: string,
  secret: string,
): Promise<string | null> {
  const dotIdx = cookie.lastIndexOf(".");
  if (dotIdx === -1) return null;

  const value = cookie.slice(0, dotIdx);
  const sigHex = cookie.slice(dotIdx + 1);
  if (!sigHex || sigHex.length !== 64) return null;

  const sigBytes = new Uint8Array(
    sigHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
  );

  const key = await hmacKey(secret, "verify");
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(value),
  );

  return valid ? value : null;
}
