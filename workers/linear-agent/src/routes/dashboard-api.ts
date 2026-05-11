/**
 * `/api/v1/*` — JSON API consumed by the dashboard SPA
 * (`workers/linear-agent/dashboard/`).
 *
 * Every route requires a valid dashboard session cookie. The cookie
 * carries the user/org binding so handlers don't need to re-derive it
 * from query params (which the SPA can't trust).
 *
 * Routes:
 *   GET  /api/v1/me                    — viewer + their install
 *   GET  /api/v1/integrations          — Linear/GH/BYO key status (redacted)
 *   POST /api/v1/integrations/:kind    — { value: string } — encrypt + store
 *   DELETE /api/v1/integrations/:kind  — clear the row
 *   GET  /api/v1/projects              — list projects for the caller's org
 *   POST /api/v1/projects              — upsert a project
 *   DELETE /api/v1/projects/:teamId    — drop a project
 *
 * The handlers DO NOT return ciphertext or plaintext for `org_credentials`;
 * the Integrations endpoint only signals "configured / not configured"
 * per kind so the SPA can show a status dot without exposing secrets.
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { encryptForOrg } from "../lib/crypto";
import { readSessionFromRequest, type SessionPayload } from "../lib/session-cookie";
import {
  InstallationStore,
  OrgCredentialStore,
  ProjectStore,
  UserStore,
} from "../lib/store";

interface Variables {
  session: SessionPayload;
}

const BYO_ALLOWED_KINDS = new Set([
  "anthropic_api_key",
  "openai_api_key",
  "cloudflare_account_id",
  "cloudflare_api_token",
]);

export function buildDashboardApiRouter() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  // Auth gate on every /api/v1/* route. Returns 401 (rather than a
  // redirect) so the SPA's fetch wrapper can navigate to the OAuth
  // URL itself — Workers' fetch follows redirects opaquely.
  app.use("/api/v1/*", async (c, next) => {
    const session = await readSessionFromRequest(c.env, c.req.raw);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("session", session);
    return next();
  });

  app.get("/api/v1/me", async (c) => {
    const session = c.get("session");
    const user = await new UserStore(c.env.DB).getById(session.uid);
    const install = await new InstallationStore(c.env.DB).get(session.oid);
    if (!user || !install) return c.json({ error: "session_user_missing" }, 401);
    return c.json({
      user: { id: user.id, email: user.email, name: user.name },
      organization: {
        id: install.organization_id,
        name: install.organization_name,
        github_app_installation_id: install.github_app_installation_id,
      },
    });
  });

  app.get("/api/v1/integrations", async (c) => {
    const session = c.get("session");
    const user = await new UserStore(c.env.DB).getById(session.uid);
    const install = await new InstallationStore(c.env.DB).get(session.oid);
    if (!user || !install) return c.json({ error: "session_user_missing" }, 401);

    const kinds = await new OrgCredentialStore(c.env.DB).listKinds(session.oid);
    const byo: Record<string, { configured: boolean }> = {};
    for (const kind of BYO_ALLOWED_KINDS) {
      byo[kind] = { configured: kinds.includes(kind) };
    }

    return c.json({
      linear: {
        connected: true,
        user: { id: user.id, email: user.email, name: user.name },
        org: {
          id: install.organization_id,
          name: install.organization_name,
          github_app_installation_id: install.github_app_installation_id,
        },
      },
      github: {
        installed: install.github_app_installation_id !== null,
        installation_id: install.github_app_installation_id,
      },
      byo,
    });
  });

  app.post("/api/v1/integrations/:kind", async (c) => {
    const session = c.get("session");
    const kind = c.req.param("kind");
    if (!BYO_ALLOWED_KINDS.has(kind)) {
      return c.json({ error: "unsupported_kind" }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as
      | { value?: unknown }
      | null;
    if (!body || typeof body.value !== "string" || body.value.length === 0) {
      return c.json({ error: "missing_value" }, 400);
    }
    if (!c.env.KEK_V1) {
      return c.json({ error: "kek_unset" }, 500);
    }
    const blob = await encryptForOrg(c.env, body.value);
    await new OrgCredentialStore(c.env.DB).upsert({
      organizationId: session.oid,
      kind,
      blob,
    });
    return c.json({ ok: true });
  });

  app.delete("/api/v1/integrations/:kind", async (c) => {
    const session = c.get("session");
    const kind = c.req.param("kind");
    if (!BYO_ALLOWED_KINDS.has(kind)) {
      return c.json({ error: "unsupported_kind" }, 400);
    }
    const removed = await new OrgCredentialStore(c.env.DB).delete(
      session.oid,
      kind,
    );
    return c.json({ ok: removed });
  });

  app.get("/api/v1/projects", async (c) => {
    const session = c.get("session");
    const projects = await new ProjectStore(c.env.DB).listForOrg(session.oid);
    return c.json({ projects });
  });

  app.post("/api/v1/projects", async (c) => {
    const session = c.get("session");
    const body = (await c.req.json().catch(() => null)) as
      | {
          team_id?: unknown;
          repo_url?: unknown;
          default_branch?: unknown;
          engine?: unknown;
          model?: unknown;
          max_turns?: unknown;
          scope_override?: unknown;
          system_prompt_override?: unknown;
        }
      | null;
    if (
      !body ||
      typeof body.team_id !== "string" ||
      body.team_id.length === 0
    ) {
      return c.json({ error: "invalid_team_id" }, 400);
    }
    if (typeof body.repo_url !== "string" || !/^https?:\/\//.test(body.repo_url)) {
      return c.json({ error: "invalid_repo_url" }, 400);
    }
    await new ProjectStore(c.env.DB).upsert({
      teamId: body.team_id,
      organizationId: session.oid,
      repoUrl: body.repo_url,
      defaultBranch: typeof body.default_branch === "string" ? body.default_branch : undefined,
      engine: typeof body.engine === "string" ? body.engine : undefined,
      model: typeof body.model === "string" ? body.model : null,
      maxTurns:
        typeof body.max_turns === "number" && body.max_turns > 0 && body.max_turns <= 100
          ? body.max_turns
          : undefined,
      scopeOverride:
        typeof body.scope_override === "string" ? body.scope_override : null,
      systemPromptOverride:
        typeof body.system_prompt_override === "string"
          ? body.system_prompt_override
          : null,
    });
    const stored = await new ProjectStore(c.env.DB).get(body.team_id);
    return c.json({ ok: true, project: stored });
  });

  app.delete("/api/v1/projects/:teamId", async (c) => {
    const removed = await new ProjectStore(c.env.DB).delete(
      c.req.param("teamId"),
    );
    return c.json({ ok: removed });
  });

  return app;
}
