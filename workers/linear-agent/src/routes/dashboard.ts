import { Hono } from "hono";
import type { Env } from "../index";
import { SessionStore } from "../lib/store";

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function sessionCookie(
  token: string,
  maxAgeSec: number,
  secure: boolean,
): string {
  const parts = [
    `dashboard_session=${token}`,
    `Path=/dashboard`,
    `HttpOnly`,
    `SameSite=Strict`,
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie("deleted", 0, secure);
}

export function setSessionCookie(
  token: string,
  ttlDays: number,
  secure: boolean,
): string {
  return sessionCookie(token, ttlDays * 86_400, secure);
}

export function buildDashboardRouter() {
  const router = new Hono<{ Bindings: Env }>();

  // --- API routes (before the SPA catch-all) ---

  router.get("/dashboard/api/me", async (c) => {
    const cookieHeader = c.req.header("cookie");
    const token = parseCookie(cookieHeader, "dashboard_session");
    if (!token) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    const user = await new SessionStore(c.env.DB).validate(token);
    if (!user) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    return c.json({
      id: user.linear_user_id,
      email: user.email,
      name: user.name,
      avatarUrl: null,
    });
  });

  router.post("/dashboard/logout", async (c) => {
    const cookieHeader = c.req.header("cookie");
    const token = parseCookie(cookieHeader, "dashboard_session");
    if (token) {
      await new SessionStore(c.env.DB).delete(token);
    }
    const secure = new URL(c.req.url).protocol === "https:";
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/dashboard/login",
        "Set-Cookie": clearSessionCookie(secure),
      },
    });
  });

  // --- Static asset serving with auth gate ---

  router.get("/dashboard/login", async (c) => {
    return serveAsset(c);
  });

  router.get("/dashboard/login/*", async (c) => {
    return serveAsset(c);
  });

  router.get("/dashboard/*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname;

    // Allow static assets through without auth (JS, CSS, images, fonts)
    if (/\.(js|css|svg|png|jpg|ico|woff2?|ttf|map)$/i.test(path)) {
      return serveAsset(c);
    }

    const cookieHeader = c.req.header("cookie");
    const token = parseCookie(cookieHeader, "dashboard_session");
    if (token) {
      const user = await new SessionStore(c.env.DB).validate(token);
      if (user) {
        return serveAsset(c);
      }
    }

    return c.redirect("/dashboard/login", 302);
  });

  router.get("/dashboard", async (c) => {
    const cookieHeader = c.req.header("cookie");
    const token = parseCookie(cookieHeader, "dashboard_session");
    if (token) {
      const user = await new SessionStore(c.env.DB).validate(token);
      if (user) {
        return serveAsset(c);
      }
    }
    return c.redirect("/dashboard/login", 302);
  });

  return router;
}

async function serveAsset(c: {
  req: { raw: Request; url: string };
  env: { ASSETS: Fetcher };
}) {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (response.status === 404) {
    const url = new URL(c.req.url);
    url.pathname = "/dashboard/index.html";
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  }
  return response;
}
