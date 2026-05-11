/**
 * Thin fetch wrapper for `/api/v1/*`. Mirrors the worker's JSON
 * contract (handlers in `src/routes/dashboard-api.ts`). All requests
 * are cookie-authenticated; 401 responses redirect to the user-OAuth
 * authorize URL.
 */

const API_BASE = "/api/v1";

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`api_error: ${status}`);
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    throw new ApiError(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface Me {
  user: { id: string; email: string | null; name: string | null };
  organization: {
    id: string;
    name: string | null;
    github_app_installation_id: number | null;
  };
}

export interface IntegrationsState {
  linear: { connected: true; user: Me["user"]; org: Me["organization"] };
  github: { installed: boolean; installation_id: number | null };
  byo: Record<string, { configured: boolean }>;
}

export interface Project {
  team_id: string;
  organization_id: string | null;
  repo_url: string;
  default_branch: string;
  engine: string;
  model: string | null;
  max_turns: number;
  scope_override: string | null;
  system_prompt_override: string | null;
  updated_at: string;
}

export const api = {
  me(): Promise<Me> {
    return request("/me");
  },
  integrations(): Promise<IntegrationsState> {
    return request("/integrations");
  },
  setIntegration(kind: string, value: string): Promise<{ ok: true }> {
    return request(`/integrations/${encodeURIComponent(kind)}`, {
      method: "POST",
      body: JSON.stringify({ value }),
    });
  },
  deleteIntegration(kind: string): Promise<{ ok: true }> {
    return request(`/integrations/${encodeURIComponent(kind)}`, {
      method: "DELETE",
    });
  },
  listProjects(): Promise<{ projects: Project[] }> {
    return request("/projects");
  },
  saveProject(input: {
    team_id: string;
    repo_url: string;
    default_branch?: string;
    engine?: string;
    model?: string | null;
    max_turns?: number;
    scope_override?: string | null;
    system_prompt_override?: string | null;
  }): Promise<{ ok: true; project: Project }> {
    return request(`/projects`, { method: "POST", body: JSON.stringify(input) });
  },
  deleteProject(teamId: string): Promise<{ ok: boolean }> {
    return request(`/projects/${encodeURIComponent(teamId)}`, {
      method: "DELETE",
    });
  },
};
