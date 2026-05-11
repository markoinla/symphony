export interface Project {
  id: number;
  org_id: string;
  linear_team_id: string;
  linear_team_name: string;
  repo_url: string;
  default_branch: string;
  engine: string;
  model: string | null;
  max_turns: number;
  scope: string | null;
  system_prompt_override: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectInput {
  linear_team_id: string;
  linear_team_name: string;
  repo_url: string;
  default_branch: string;
  engine: string;
  model: string | null;
  scope: string | null;
  system_prompt_override: string | null;
}

class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error: string; fields?: Record<string, string> },
  ) {
    super(body.error);
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    credentials: "same-origin",
  });

  const json = await res.json();

  if (!res.ok) {
    throw new ApiError(
      res.status,
      json as { error: string; fields?: Record<string, string> },
    );
  }

  return json as T;
}

export async function listProjects(): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>(
    "/dashboard/api/projects",
  );
  return data.projects;
}

export async function createProject(input: ProjectInput): Promise<Project> {
  const data = await request<{ project: Project }>("/dashboard/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.project;
}

export async function updateProject(
  id: number,
  input: Partial<ProjectInput>,
): Promise<Project> {
  const data = await request<{ project: Project }>(
    `/dashboard/api/projects/${id}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
  return data.project;
}

export async function deleteProject(id: number): Promise<void> {
  await request<{ ok: boolean }>(`/dashboard/api/projects/${id}`, {
    method: "DELETE",
  });
}

export { ApiError };

const BASE = "/dashboard/api";

export interface SessionRow {
  id: string;
  linear_issue_id: string | null;
  linear_issue_title: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  triggered_by: string | null;
  team: string | null;
  repo: string | null;
}

export interface SessionDebug extends SessionRow {
  prompt: string | null;
  config_snapshot: Record<string, unknown> | null;
  stderr: string | null;
  dispatcher_logs: DispatcherLogEntry[];
  messages: EventSummaryItem[];
  error: string | null;
}

export interface DispatcherLogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface EventSummaryItem {
  type: string;
  timestamp: string;
  body?: string;
}

export interface SessionFilters {
  team?: string;
  repo?: string;
  status?: string;
  triggered_by?: string;
}

export async function fetchSessions(
  filters: SessionFilters = {},
): Promise<SessionRow[]> {
  const params = new URLSearchParams();
  if (filters.team) params.set("team", filters.team);
  if (filters.repo) params.set("repo", filters.repo);
  if (filters.status) params.set("status", filters.status);
  if (filters.triggered_by) params.set("triggered_by", filters.triggered_by);

  const qs = params.toString();
  const url = `${BASE}/sessions${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
  const data = (await res.json()) as { sessions: SessionRow[] };
  return data.sessions;
}

export async function fetchSessionDebug(id: string): Promise<SessionDebug> {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(id)}/debug`);
  if (!res.ok)
    throw new Error(`Failed to fetch session debug: ${res.status}`);
  return (await res.json()) as SessionDebug;
}

export async function rerunSession(
  id: string,
  prompt?: string,
): Promise<{ ok: boolean; new_session_id: string }> {
  const res = await fetch(
    `${BASE}/sessions/${encodeURIComponent(id)}/rerun`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prompt ? { prompt } : {}),
    },
  );
  if (!res.ok) throw new Error(`Failed to rerun session: ${res.status}`);
  return (await res.json()) as { ok: boolean; new_session_id: string };
}
