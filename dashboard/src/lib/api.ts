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
  github_branch: string | null
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
  error_category: string | null
  workflow_name: string | null
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
    error_category: string | null
    workflow_name: string | null
    github_branch: string | null
    github_repo: string | null
    project_name: string | null
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

export type LoadedWorkflow = {
  name: string
  display_name: string
}

export type StatePayload = {
  generated_at: string
  counts: {
    running: number
    retrying: number
  }
  loaded_workflows?: LoadedWorkflow[]
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

export async function getState() {
  const payload = await requestJson<StatePayload>('/api/v1/state')
  if (payload?.error) {
    throw new ApiError(200, { error: payload.error }, payload.error.message)
  }
  return payload
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

export type AgentWorkflow = {
  name: string
  enabled: boolean
  loaded: boolean
  description: string | null
  config: {
    max_concurrent_agents?: number
    polling_interval_ms?: number
    max_turns?: number
    engine?: string
  }
  raw_config: Record<string, unknown>
}

export function getAgents() {
  return requestJson<{ agents: AgentWorkflow[] }>('/api/v1/agents')
}

export function updateAgent(name: string, attrs: { enabled: boolean }) {
  return requestJson<{ agent: AgentWorkflow }>(`/api/v1/agents/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify(attrs),
  })
}

export type OAuthStatus = {
  status: 'connected' | 'expired' | 'disconnected'
  expires_at: string | null
  credentials_source: 'env' | 'store' | 'none'
  proxy_available: boolean
}

export function getOAuthStatus() {
  return requestJson<OAuthStatus>('/api/v1/oauth/linear/status')
}

export type OAuthAuthorizeResponse = {
  authorize_url: string
  flow: 'direct' | 'proxy'
  state?: string
}

export function getOAuthAuthorizeUrl() {
  return requestJson<OAuthAuthorizeResponse>('/api/v1/oauth/linear/authorize')
}

export function revokeOAuth() {
  return requestJson<{ status: string }>('/api/v1/oauth/linear/revoke', {
    method: 'POST',
  })
}

export function getGitHubOAuthStatus() {
  return requestJson<OAuthStatus>('/api/v1/oauth/github/status')
}

export function getGitHubOAuthAuthorizeUrl() {
  return requestJson<OAuthAuthorizeResponse>('/api/v1/oauth/github/authorize')
}

export function revokeGitHubOAuth() {
  return requestJson<{ status: string }>('/api/v1/oauth/github/revoke', {
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
      error_category: null,
      workflow_name: null,
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

export type AuthStatus = {
  authenticated: boolean
  auth_required: boolean
}

export function getAuthStatus() {
  return requestJson<AuthStatus>('/api/v1/auth/status')
}

export function login(password: string) {
  return requestJson<{ ok: boolean }>('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

export function logout() {
  return requestJson<{ ok: boolean }>('/api/v1/auth/logout', {
    method: 'POST',
  })
}

export type LinearProject = {
  id: string
  name: string
  slug_id: string
  slug: string
  url: string
  state: string
  organization_slug: string | null
  team_key: string | null
}

export type GitHubRepo = {
  id: number
  full_name: string
  name: string
  owner: string
  description: string | null
  private: boolean
  default_branch: string
  url: string
}

export function searchLinearProjects(query: string) {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  return requestJson<{ projects: LinearProject[] }>(`/api/v1/linear/projects?${params.toString()}`)
}

export function searchGitHubRepos(query: string) {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  return requestJson<{ repos: GitHubRepo[] }>(`/api/v1/github/repos?${params.toString()}`)
}

// --- Session Stats ---

export type SessionStatsRange = '24h' | '7d' | '30d'

export type FailureCountBucket = {
  bucket: string
  infra: number
  agent: number
  config: number
  timeout: number
}

export type DeadLetterSession = {
  id: number
  issue_identifier: string | null
  issue_title: string | null
  status: string
  workflow_name: string | null
  error_category: string | null
  error: string | null
  ended_at: string | null
}

export type RunCountBucket = {
  bucket: string
  total: number
  successful: number
}

export type WorkerHostStats = {
  host: string
  total_runs: number
  failures: number
  failure_rate: number
}

export type SessionStats = {
  failure_counts: FailureCountBucket[]
  run_counts: RunCountBucket[]
  dead_letters: DeadLetterSession[]
  worker_health: WorkerHostStats[]
}

export async function getSessionStats(
  range: SessionStatsRange,
  filters?: { project_id?: string; workflow_name?: string },
): Promise<SessionStats> {
  const params = new URLSearchParams({ range, ...filters })
  return requestJson<SessionStats>(`/api/v1/sessions/stats?${params}`)
}

// --- Cost Analytics ---

export type CostRange = '7d' | '30d' | '90d'

export type AnalyticsSummary = {
  total_cost_cents: number
  total_sessions: number
  total_input_tokens: number
  total_output_tokens: number
}

export type DailyCostEntry = {
  date: string
  workflow: string
  cost_cents: number
  sessions: number
  input_tokens: number
  output_tokens: number
}

export type WorkflowBreakdown = {
  workflow: string
  cost_cents: number
  sessions: number
  input_tokens: number
  output_tokens: number
  avg_cost_cents_per_session: number
}

export type CostAnalyticsResponse = {
  range: CostRange
  summary: AnalyticsSummary
  daily: DailyCostEntry[]
  by_workflow: WorkflowBreakdown[]
}

export function getCostAnalytics(range: CostRange) {
  return requestJson<CostAnalyticsResponse>(`/api/v1/analytics/cost?range=${encodeURIComponent(range)}`)
}

export function setupPassword(password: string) {
  return requestJson<{ ok: boolean }>('/api/v1/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

export function changePassword(currentPassword: string, newPassword: string) {
  return requestJson<{ ok: boolean }>('/api/v1/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  })
}

// --- Proxy ---

export type ProxyStatus = {
  enabled: boolean
  instance_url: string | null
  linear_org_id: string | null
}

export function getProxyStatus() {
  return requestJson<ProxyStatus>('/api/v1/proxy/status')
}

export function proxyHealthCheck() {
  return requestJson<{ ok: boolean; error?: string }>('/api/v1/proxy/health', {
    method: 'POST',
  })
}

export function proxyRegister() {
  return requestJson<{ ok: boolean }>('/api/v1/proxy/register', {
    method: 'POST',
  })
}

export type ProxyPingResult = {
  proxy: { ok: boolean; error?: string }
  webhook: { ok: boolean; registered?: boolean; instance_url?: string; error?: string }
}

export function proxyPing() {
  return requestJson<ProxyPingResult>('/api/v1/proxy/ping', {
    method: 'POST',
  })
}

export type ProxyPollResponse = {
  status: 'complete' | 'pending'
}

export function pollLinearProxyOAuth() {
  return requestJson<ProxyPollResponse>('/api/v1/oauth/linear/proxy-poll', {
    method: 'POST',
  })
}

export function pollGitHubProxyOAuth() {
  return requestJson<ProxyPollResponse>('/api/v1/oauth/github/proxy-poll', {
    method: 'POST',
  })
}

export function emptyProject(): ProjectBody {
  return {
    name: '',
    linear_project_slug: null,
    linear_organization_slug: null,
    linear_filter_by: 'project',
    linear_label_name: null,
    github_repo: null,
    github_branch: null,
    workspace_root: null,
    env_vars: null,
  }
}
