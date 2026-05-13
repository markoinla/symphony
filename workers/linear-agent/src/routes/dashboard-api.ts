import { Hono } from "hono";
import type { Env } from "../index";
import { CredentialStore } from "../lib/credentials";
import { requireOrg } from "../lib/dashboard-auth";
import { mintInstallationToken } from "../lib/github-app";
import { buildAgentDefaults, validateSettingValue } from "../lib/settings";
import {
  LinearAgentInstallStore,
  GitHubInstallStore,
  ProjectStore,
  SettingStore,
} from "../lib/store";


// Project write paths on /dashboard/api/* are kept for the existing
// SPA but advertise a Sunset window — new clients should call
// /api/v1/projects. RFC 8594 / RFC 7231 date format.
const PROJECT_SUNSET = "Mon, 10 Aug 2026 00:00:00 GMT";
const PROJECT_DEPRECATION_LINK =
  '</api/v1/projects>; rel="successor-version"';

function attachDeprecation(c: { header: (n: string, v: string) => void }) {
  c.header("Sunset", PROJECT_SUNSET);
  c.header("Link", PROJECT_DEPRECATION_LINK);
  c.header("Deprecation", "true");
}

function buildLinearProjectSlug(name: string, slugId: string): string {
  if (!name) return slugId;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug}-${slugId}`;
}

export function buildDashboardApiRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/dashboard/api/projects", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const projects = await new ProjectStore(c.env.DB).listByOrg(
      user.organizationId,
    );
    return c.json({ projects });
  });

  app.post("/dashboard/api/projects", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    attachDeprecation(c);

    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const errors = validateProject(body);
    if (errors) {
      return c.json({ error: "validation_failed", fields: errors }, 400);
    }

    const project = await new ProjectStore(c.env.DB).upsert({
      organizationId: user.organizationId,
      linearTeamId: body!.linear_team_id as string,
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

    return c.json({ project }, 201);
  });

  app.put("/dashboard/api/projects/:id", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    attachDeprecation(c);

    const id = c.req.param("id");
    if (!id) return c.json({ error: "invalid_id" }, 400);

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

    const project = await new ProjectStore(c.env.DB).update(
      id,
      user.organizationId,
      {
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
      },
    );

    if (!project) return c.json({ error: "not_found" }, 404);
    return c.json({ project });
  });

  app.delete("/dashboard/api/projects/:id", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    attachDeprecation(c);

    const id = c.req.param("id");
    if (!id) return c.json({ error: "invalid_id" }, 400);

    const deleted = await new ProjectStore(c.env.DB).deleteById(
      id,
      user.organizationId,
    );
    if (!deleted) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  // ── Integrations ────────────────────────────────────────────────

  app.get("/dashboard/api/integrations", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const orgId = user.organizationId;
    const install = await new LinearAgentInstallStore(c.env.DB).getByOrgId(orgId);
    const github = await new GitHubInstallStore(c.env.DB).getByOrgId(orgId);
    const configuredKinds = await new CredentialStore(c.env.DB).listKinds(orgId);
    const configuredSet = new Set(configuredKinds);

    return c.json({
      linear: {
        connected: !!install,
        email: user.email,
      },
      github: {
        connected: !!github,
        repo_selection: github?.repo_selection ?? null,
        repo_count: github
          ? github.repo_selection === "all"
            ? null
            : github.selected_repos
              ? (JSON.parse(github.selected_repos) as unknown[]).length
              : 0
          : 0,
      },
      anthropic: { configured: configuredSet.has("anthropic") },
      openai: { configured: configuredSet.has("openai") },
      cf_workers_ai: { configured: configuredSet.has("cf_workers_ai") },
      github_app_settings_url: c.env.GITHUB_APP_SETTINGS_URL ?? null,
    });
  });

  app.put("/dashboard/api/integrations/credentials", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const body = await c.req.json<{ provider?: string; api_key?: string }>();
    const validProviders = ["anthropic", "openai", "cf_workers_ai"];
    if (
      !body.provider ||
      !validProviders.includes(body.provider) ||
      !body.api_key ||
      typeof body.api_key !== "string" ||
      body.api_key.trim().length === 0
    ) {
      return c.json(
        {
          error: "invalid_request",
          message: "provider and api_key are required",
        },
        400,
      );
    }

    const kek = c.env.CREDENTIAL_KEK;
    if (!kek) {
      return c.json(
        {
          error: "server_error",
          message: "Credential encryption not configured",
        },
        500,
      );
    }

    await new CredentialStore(c.env.DB).encryptForOrg(
      user.organizationId,
      body.provider,
      body.api_key.trim(),
      kek,
    );
    return c.json({ ok: true });
  });

  // ── Linear projects search ──────────────────────────────────────

  app.get("/dashboard/api/linear/projects", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const install = await new LinearAgentInstallStore(c.env.DB).getByOrgId(
      user.organizationId,
    );
    if (!install) return c.json({ error: "linear_not_connected" }, 503);

    // Linear has a per-query complexity cap of 10000. Each nested
    // connection multiplies its parent's complexity by its page size
    // (default 50), so we bound the teams subselection to one item —
    // we only use the first team in the response mapping anyway.
    const query = `
      query ListProjects($filter: ProjectFilter, $first: Int!) {
        projects(filter: $filter, first: $first) {
          nodes {
            id
            name
            slugId
            url
            state
            teams(first: 1) {
              nodes {
                id
                key
                organization { urlKey }
              }
            }
          }
        }
      }
    `;

    // Active states only. Cancelled/completed clutter the picker; an
    // unfiltered call appears to trigger Linear-side errors for
    // actor=app tokens.
    const filter = {
      state: { in: ["backlog", "planned", "started", "paused"] },
    };

    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: install.access_token.startsWith("Bearer ")
          ? install.access_token
          : `Bearer ${install.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        operationName: "ListProjects",
        variables: { filter, first: 100 },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return c.json(
        {
          error: "linear_api_error",
          status: res.status,
          message: body.slice(0, 500),
        },
        502,
      );
    }

    const json = (await res.json()) as {
      data?: {
        projects?: {
          nodes?: Array<{
            id: string;
            name: string;
            slugId: string;
            url: string;
            state: string;
            teams?: {
              nodes?: Array<{
                id: string;
                key: string;
                organization?: { urlKey?: string | null };
              }>;
            };
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (json.errors && json.errors.length > 0) {
      return c.json(
        {
          error: "linear_graphql_error",
          message: json.errors[0]?.message ?? "Unknown Linear GraphQL error",
        },
        502,
      );
    }

    const nodes = json.data?.projects?.nodes ?? [];

    const projects = nodes.map((n) => {
      const team = n.teams?.nodes?.[0] ?? null;
      return {
        id: n.id,
        name: n.name,
        slug_id: n.slugId,
        slug: buildLinearProjectSlug(n.name, n.slugId),
        url: n.url,
        state: n.state,
        organization_slug: team?.organization?.urlKey ?? null,
        team_id: team?.id ?? null,
        team_key: team?.key ?? null,
      };
    });

    return c.json({ projects });
  });

  // ── GitHub repos search ─────────────────────────────────────────

  app.get("/dashboard/api/github/repos", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const install = await new GitHubInstallStore(c.env.DB).getByOrgId(
      user.organizationId,
    );
    if (!install) return c.json({ error: "github_not_installed" }, 503);

    const appId = c.env.GITHUB_APP_ID;
    const privateKey = c.env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !privateKey) {
      return c.json({ error: "github_app_not_configured" }, 503);
    }

    let installToken: string;
    try {
      installToken = await mintInstallationToken(
        install.install_id,
        appId,
        privateKey,
      );
    } catch (e) {
      return c.json(
        {
          error: "github_token_mint_failed",
          message: e instanceof Error ? e.message : String(e),
        },
        503,
      );
    }

    const res = await fetch(
      "https://api.github.com/installation/repositories?per_page=100",
      {
        headers: {
          Authorization: `Bearer ${installToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "symphony-linear-agent",
        },
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return c.json(
        {
          error: "github_api_error",
          status: res.status,
          message: body.slice(0, 500),
        },
        502,
      );
    }

    const json = (await res.json()) as {
      repositories?: Array<{
        id: number;
        name: string;
        full_name: string;
        owner: { login: string };
        description: string | null;
        private: boolean;
        default_branch: string;
        html_url: string;
      }>;
    };

    const repos = (json.repositories ?? []).map((r) => ({
      id: r.id,
      full_name: r.full_name,
      name: r.name,
      owner: r.owner.login,
      description: r.description,
      private: r.private,
      default_branch: r.default_branch,
      url: r.html_url,
    }));

    return c.json({ repos });
  });

  // ── Settings (org-scoped key/value store) ───────────────────────
  //
  // Free-form k/v: the Advanced settings UI accepts arbitrary keys
  // (proxy.enabled, domain, tracker.api_key, …) so the upsert path
  // does not gate on a key allowlist. Curated keys consumed by the
  // runtime (agent.default_engine / .default_model / .max_turns)
  // get per-key value validation below.

  app.get("/dashboard/api/settings", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const settings = await new SettingStore(c.env.DB).list(user.organizationId);
    return c.json({
      settings,
      agent_defaults: buildAgentDefaults(c.env),
    });
  });

  app.put("/dashboard/api/settings/:key", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const key = c.req.param("key");
    if (!key || key.length > 200) {
      return c.json({ error: "invalid_key" }, 400);
    }

    const body = await c.req.json<{ value?: unknown }>().catch(() => null);
    if (!body || typeof body.value !== "string") {
      return c.json({ error: "invalid_body" }, 400);
    }

    const validationError = validateSettingValue(key, body.value);
    if (validationError) {
      return c.json(
        { error: "validation_failed", message: validationError },
        400,
      );
    }

    await new SettingStore(c.env.DB).upsert(
      user.organizationId,
      key,
      body.value,
    );
    return c.json({ setting: { key, value: body.value } });
  });

  app.delete("/dashboard/api/settings/:key", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const key = c.req.param("key");
    if (!key) return c.json({ error: "invalid_key" }, 400);

    const removed = await new SettingStore(c.env.DB).delete(
      user.organizationId,
      key,
    );
    if (!removed) return c.json({ error: "not_found" }, 404);
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
