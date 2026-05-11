import { Hono } from "hono";
import type { Env } from "../index";
import { requireDashboardAuth } from "../lib/dashboard-auth";
import { ProjectStore } from "../lib/store";

export function buildDashboardApiRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/dashboard/api/projects", async (c) => {
    const user = await requireDashboardAuth(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const projects = await new ProjectStore(c.env.DB).listByOrg(
      user.organizationId,
    );
    return c.json({ projects });
  });

  app.post("/dashboard/api/projects", async (c) => {
    const user = await requireDashboardAuth(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const errors = validateProject(body);
    if (errors) {
      return c.json({ error: "validation_failed", fields: errors }, 400);
    }

    const store = new ProjectStore(c.env.DB);
    await store.upsert({
      orgId: user.organizationId,
      teamId: body!.linear_team_id as string,
      linearTeamName: (body!.linear_team_name as string) ?? "",
      repoUrl: body!.repo_url as string,
      defaultBranch: (body!.default_branch as string) || "main",
      engine: (body!.engine as string) || "pi",
      model: (body!.model as string) || null,
      maxTurns:
        typeof body!.max_turns === "number" ? body!.max_turns : undefined,
      scope: (body!.scope as string) || null,
      systemPromptOverride: (body!.system_prompt_override as string) || null,
    });

    const created = await store.get(body!.linear_team_id as string);
    return c.json({ project: created }, 201);
  });

  app.put("/dashboard/api/projects/:id", async (c) => {
    const user = await requireDashboardAuth(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) {
      return c.json({ error: "invalid_id" }, 400);
    }

    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return c.json({ error: "invalid_body" }, 400);

    if (
      body.repo_url !== undefined &&
      typeof body.repo_url === "string" &&
      !/^https?:\/\/.+/.test(body.repo_url)
    ) {
      return c.json(
        {
          error: "validation_failed",
          fields: { repo_url: "Must be a valid URL" },
        },
        400,
      );
    }

    const store = new ProjectStore(c.env.DB);
    const project = await store.update(id, user.organizationId, {
      linearTeamId: body.linear_team_id as string | undefined,
      linearTeamName: body.linear_team_name as string | undefined,
      repoUrl: body.repo_url as string | undefined,
      defaultBranch: body.default_branch as string | undefined,
      engine: body.engine as string | undefined,
      model: body.model as string | null | undefined,
      maxTurns: body.max_turns as number | undefined,
      scope: body.scope as string | null | undefined,
      systemPromptOverride: body.system_prompt_override as
        | string
        | null
        | undefined,
    });

    if (!project) return c.json({ error: "not_found" }, 404);
    return c.json({ project });
  });

  app.delete("/dashboard/api/projects/:id", async (c) => {
    const user = await requireDashboardAuth(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) {
      return c.json({ error: "invalid_id" }, 400);
    }

    const deleted = await new ProjectStore(c.env.DB).deleteById(
      id,
      user.organizationId,
    );
    if (!deleted) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}

function validateProject(
  body: Record<string, unknown> | null,
): Record<string, string> | null {
  if (!body) return { _form: "Request body is required" };

  const errors: Record<string, string> = {};

  if (typeof body.linear_team_id !== "string" || !body.linear_team_id.trim()) {
    errors.linear_team_id = "Team ID is required";
  }
  if (typeof body.repo_url !== "string" || !body.repo_url.trim()) {
    errors.repo_url = "Repo URL is required";
  } else if (!/^https?:\/\/.+/.test(body.repo_url)) {
    errors.repo_url = "Must be a valid URL";
  }
  if (
    body.default_branch !== undefined &&
    typeof body.default_branch === "string" &&
    !body.default_branch.trim()
  ) {
    errors.default_branch = "Branch cannot be empty";
  }

  return Object.keys(errors).length > 0 ? errors : null;
}
