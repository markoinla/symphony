export type ApiErrorPayload = {
  error?: {
    code?: string
    message?: string
    details?: Record<string, string[]>
  }
}

export class ApiError extends Error {
  status: number
  payload: ApiErrorPayload | null

  constructor(status: number, payload: ApiErrorPayload | null, fallback: string) {
    super(payload?.error?.message ?? fallback)
    this.status = status
    this.payload = payload
  }
}

export type Project = {
  id: number
  name: string
  linear_project_slug: string | null
  linear_organization_slug: string | null
  linear_filter_by: string | null
  linear_label_name: string | null
  github_repo: string | null
  workspace_root: string | null
  env_vars: string | null
  created_at: string | null
  updated_at: string | null
}

export type Setting = {
  key: string
  value: string
}

export type AgentSettingsDefaults = {
  max_concurrent_agents: number
  max_turns: number
}

export type SettingsPayload = {
  settings: Setting[]
  agent_defaults: AgentSettingsDefaults
}

export type TimelineMessage = {
  id: number | string
  timestamp: string | null
  type: string
  content: string
  metadata: Record<string, unknown>
}

export type TimelineSession = {
  id: number | null
  issue_identifier: string | null
  issue_title: string | null
  session_id: string
  status: string
  started_at: string | null
  ended_at: string | null
  turn_count: number | null
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  worker_host: string | null
  error: string | null
  live: boolean
  messages: TimelineMessage[]
}

export type SessionsPayload = {
  sessions: Array<{
    id: number
    issue_identifier: string | null
    issue_title: string | null
    session_id: string | null
    status: string
    started_at: string | null
    ended_at: string | null
    turn_count: number
    input_tokens: number
    output_tokens: number
    total_tokens: number
    worker_host: string | null
    error: string | null
  }>
}

export type MessagesPayload = {
  issue_identifier: string
  issue_id: string | null
  issue_title: string | null
  status: string
  active_session_id: string | null
  sessions: TimelineSession[]
}

export type IssuePayload = {
  issue_identifier: string
  issue_id: string
  status: string
  workspace: {
    path: string | null
    host: string | null
  }
  attempts: {
    restart_count: number
    current_retry_attempt: number
  }
  running: {
    worker_host: string | null
    workspace_path: string | null
    session_id: string | null
    turn_count: number
    state: string
    started_at: string | null
    last_event: string | null
    last_message: string | null
    last_event_at: string | null
    tokens: {
      input_tokens: number
      output_tokens: number
      total_tokens: number
    }
  } | null
  retry: {
    attempt: number
    due_at: string | null
    error: string | null
    worker_host: string | null
    workspace_path: string | null
  } | null
  recent_events: Array<{
    at: string | null
    event: string | null
    message: string | null
  }>
}

export type StatePayload = {
  generated_at: string
  counts: {
    running: number
    retrying: number
  }
  running: Array<{
    issue_id: string
    issue_identifier: string
    project_id: number | null
    project_name: string | null
    workflow_name?: string
    state: string
    worker_host: string | null
    workspace_path: string | null
    session_id: string | null
    turn_count: number
    last_event: string | null
    last_message: string | null
    started_at: string | null
    last_event_at: string | null
    tokens: {
      input_tokens: number
      output_tokens: number
      total_tokens: number
    }
  }>
  retrying: Array<{
    issue_id: string
    issue_identifier: string
    project_id: number | null
    project_name: string | null
    workflow_name?: string
    attempt: number
    due_at: string | null
    error: string | null
    worker_host: string | null
    workspace_path: string | null
  }>
  engine_totals: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    seconds_running: number
  }
  error?: {
    code: string
    message: string
  }
}

type ProjectBody = Omit<Project, 'id' | 'created_at' | 'updated_at'>

async function requestJson<T>(input: string, init?: RequestInit) {
  const response = await fetch(input, {
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  if (response.status === 204) {
    return null as T
  }

  const payload = (await response.json()) as T | ApiErrorPayload

  if (!response.ok) {
    throw new ApiError(response.status, payload as ApiErrorPayload, 'Request failed')
  }

  return payload as T
}

export function getState() {
  return requestJson<StatePayload>('/api/v1/state')
}

export async function getIssue(issueIdentifier: string) {
  try {
    return await requestJson<IssuePayload>(`/api/v1/${encodeURIComponent(issueIdentifier)}`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null
    }

    throw error
  }
}

export function getSessionTimeline(issueIdentifier: string) {
  return requestJson<MessagesPayload>(`/api/v1/${encodeURIComponent(issueIdentifier)}/messages`)
}

export function getSessions(params?: { issueIdentifier?: string; limit?: number; projectId?: number }) {
  const search = new URLSearchParams()

  if (params?.issueIdentifier) {
    search.set('issue_identifier', params.issueIdentifier)
  }

  if (params?.limit) {
    search.set('limit', String(params.limit))
  }

  if (params?.projectId) {
    search.set('project_id', String(params.projectId))
  }

  const query = search.toString()
  return requestJson<SessionsPayload>(`/api/v1/sessions${query ? `?${query}` : ''}`)
}

export function getProjects() {
  return requestJson<{ projects: Project[] }>('/api/v1/projects')
}

export function createProject(body: ProjectBody) {
  return requestJson<{ project: Project }>('/api/v1/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateProject(id: number, body: ProjectBody) {
  return requestJson<{ project: Project }>(`/api/v1/projects/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function deleteProject(id: number) {
  return requestJson<null>(`/api/v1/projects/${id}`, {
    method: 'DELETE',
  })
}

export function getSettings() {
  return requestJson<SettingsPayload>('/api/v1/settings')
}

export function upsertSetting(key: string, value: string) {
  return requestJson<{ setting: Setting }>(`/api/v1/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  })
}

export function deleteSetting(key: string) {
  return requestJson<null>(`/api/v1/settings/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
}

export type OAuthStatus = {
  status: 'connected' | 'expired' | 'disconnected'
  expires_at: string | null
}

export function getOAuthStatus() {
  return requestJson<OAuthStatus>('/api/v1/oauth/linear/status')
}

export function getOAuthAuthorizeUrl() {
  return requestJson<{ authorize_url: string }>('/api/v1/oauth/linear/authorize')
}

export function revokeOAuth() {
  return requestJson<{ status: string }>('/api/v1/oauth/linear/revoke', {
    method: 'POST',
  })
}

export function mergeTimelineMessage(payload: MessagesPayload, incoming: TimelineMessage) {
  const sessions = [...payload.sessions]
  const activeIndex = sessions.findIndex((session) => session.live)

  if (activeIndex === -1) {
    const fallbackSessionId = payload.active_session_id ?? 'live'

    sessions.push({
      id: null,
      issue_identifier: payload.issue_identifier,
      issue_title: payload.issue_title,
      session_id: fallbackSessionId,
      status: 'running',
      started_at: incoming.timestamp,
      ended_at: null,
      turn_count: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      worker_host: null,
      error: null,
      live: true,
      messages: [incoming],
    })
  } else {
    const session = sessions[activeIndex]
    sessions[activeIndex] = { ...session, messages: [...session.messages, incoming] }
  }

  return { ...payload, sessions }
}

export function updateTimelineMessage(payload: MessagesPayload, incoming: TimelineMessage) {
  const sessions = payload.sessions.map((session) => {
    if (!session.live) {
      return session
    }

    const nextMessages = [...session.messages]
    const lastIndex = nextMessages.findLastIndex((message) => String(message.id) === String(incoming.id))

    if (lastIndex >= 0) {
      nextMessages[lastIndex] = incoming
    } else {
      nextMessages.push(incoming)
    }

    return { ...session, messages: nextMessages }
  })

  return { ...payload, sessions }
}

export function emptyProject(): ProjectBody {
  return {
    name: '',
    linear_project_slug: null,
    linear_organization_slug: null,
    linear_filter_by: 'project',
    linear_label_name: null,
    github_repo: null,
    workspace_root: null,
    env_vars: null,
  }
}
