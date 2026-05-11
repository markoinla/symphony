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
