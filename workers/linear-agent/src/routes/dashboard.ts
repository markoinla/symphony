import { Hono } from "hono";
import type { Env } from "../index";

export function buildDashboardRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/dashboard/*", async (c) => {
    const response = await c.env.ASSETS.fetch(c.req.raw);
    if (response.status === 404) {
      // SPA catch-all: serve index.html for client-side routing
      const url = new URL(c.req.url);
      url.pathname = "/dashboard/index.html";
      return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
    }
    return response;
  });

  router.get("/dashboard", async (c) => {
    const url = new URL(c.req.url);
    url.pathname = "/dashboard/index.html";
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  });

  return router;
}
