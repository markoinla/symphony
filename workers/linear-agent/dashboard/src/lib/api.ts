// Dashboard API client for the linear-agent Cloudflare Worker.
//
// This file preserves the export surface of the original Symphony API
// client (so the ported pages compile unchanged) but routes every call
// to the Worker's `/dashboard/api/*` and `/oauth/*` endpoints. Where the
// Worker has no equivalent yet (settings KV, in-flight orchestrator
// state, per-session SSE timeline, Linear project search, GitHub repo
// search, proxy flow) the function returns a benign empty/disabled
// shape and logs a one-time `console.warn` so unimplemented surfaces are
// visible in the browser console as we wire them up.
//
// Worker route reference:
//   src/routes/dashboard.ts      — /dashboard/api/me, /dashboard/api/sessions*
//   src/routes/dashboard-api.ts  — /dashboard/api/projects*, /dashboard/api/integrations*
//   src/routes/oauth.ts          — /linear/agent-install (agent install flow)
//   src/routes/github.ts         — /github/install
//   Better Auth                  — /api/auth/* (sign-in, sign-up, signout, org plugin)

import { authClient } from "./auth-client";

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

// ── Types (preserved from Symphony so pages compile unchanged) ──────

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
  default_engine: string
  default_model: string | null
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
    detail_session_id: string | null
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
  workspace: { path: string | null; host: string | null }
  attempts: { restart_count: number; current_retry_attempt: number }
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
    tokens: { input_tokens: number; output_tokens: number; total_tokens: number }
  } | null
  retry: {
    attempt: number
    due_at: string | null
    error: string | null
    worker_host: string | null
    workspace_path: string | null
  } | null
  recent_events: Array<{ at: string | null; event: string | null; message: string | null }>
}

export type LoadedWorkflow = { name: string; display_name: string }

export type StatePayload = {
  generated_at: string
  counts: { running: number; retrying: number }
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
    tokens: { input_tokens: number; output_tokens: number; total_tokens: number }
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
  error?: { code: string; message: string }
}

export type ProjectBody = Omit<Project, 'id' | 'created_at' | 'updated_at'>

// ── HTTP helper ─────────────────────────────────────────────────────

async function requestJson<T>(input: string, init?: RequestInit) {
  const response = await fetch(input, {
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    credentials: 'same-origin',
    ...init,
  })

  if (response.status === 204) {
    return null as T
  }

  let payload: T | ApiErrorPayload
  try {
    payload = (await response.json()) as T | ApiErrorPayload
  } catch {
    payload = null as unknown as T
  }

  if (!response.ok) {
    throw new ApiError(response.status, payload as ApiErrorPayload, 'Request failed')
  }

  return payload as T
}

const warned = new Set<string>()
function warnUnimplemented(name: string) {
  if (warned.has(name)) return
  warned.add(name)
  // eslint-disable-next-line no-console
  console.warn(`[linear-agent dashboard] TODO: ${name} — Worker route not yet wired`)
}

// ── Auth (Better Auth) ──────────────────────────────────────────────

export type CurrentUser = {
  id: number
  email: string
  name: string | null
}

export type AuthStatus = {
  authenticated: boolean
  auth_required: boolean
  user?: CurrentUser
}

function stableHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const { data, error } = await authClient.getSession()
  if (error) {
    if (error.status === 401) {
      return { authenticated: false, auth_required: true }
    }
    throw new ApiError(error.status ?? 500, null, error.message ?? 'Auth lookup failed')
  }
  if (!data) {
    return { authenticated: false, auth_required: true }
  }
  return {
    authenticated: true,
    auth_required: true,
    user: {
      // Pages expect a numeric id from the Symphony shape; Better Auth
      // ids are uuid strings. Hash to a stable int — only used for UI
      // identity, not for any DB join.
      id: stableHash(data.user.id),
      email: data.user.email,
      name: data.user.name ?? null,
    },
  }
}

export async function login(
  email: string,
  password: string,
): Promise<{ ok: boolean; user: CurrentUser }> {
  const { data, error } = await authClient.signIn.email({ email, password })
  if (error) {
    throw new ApiError(error.status ?? 401, null, error.message ?? 'Invalid credentials')
  }
  if (!data) {
    throw new ApiError(401, null, 'Sign-in returned no session')
  }
  return {
    ok: true,
    user: {
      id: stableHash(data.user.id),
      email: data.user.email,
      name: data.user.name ?? null,
    },
  }
}

export async function setupAccount(
  email: string,
  password: string,
  name?: string,
): Promise<{ ok: boolean; user: CurrentUser }> {
  const { data, error } = await authClient.signUp.email({
    email,
    password,
    name: name ?? email.split('@')[0],
  })
  if (error) {
    // Map "user exists" to the legacy 409 the setup form recognizes.
    const status = /already exists|exists/i.test(error.message ?? '')
      ? 409
      : (error.status ?? 422)
    throw new ApiError(status, null, error.message ?? 'Sign-up failed')
  }
  if (!data) {
    throw new ApiError(422, null, 'Sign-up returned no session')
  }
  return {
    ok: true,
    user: {
      id: stableHash(data.user.id),
      email: data.user.email,
      name: data.user.name ?? null,
    },
  }
}

export async function logout() {
  const { error } = await authClient.signOut()
  if (error) {
    throw new ApiError(error.status ?? 500, null, error.message ?? 'Logout failed')
  }
  return { ok: true }
}

export async function changePassword(current: string, next: string) {
  const { error } = await authClient.changePassword({
    currentPassword: current,
    newPassword: next,
  })
  if (error) {
    throw new ApiError(error.status ?? 400, null, error.message ?? 'Password change failed')
  }
  return { ok: true }
}

// ── Orchestrator state (no Worker equivalent yet) ───────────────────

export function getState(): Promise<StatePayload> {
  warnUnimplemented('getState')
  return Promise.resolve({
    generated_at: new Date().toISOString(),
    counts: { running: 0, retrying: 0 },
    running: [],
    retrying: [],
    engine_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
  })
}

export function getIssue(_issueIdentifier: string): Promise<IssuePayload | null> {
  warnUnimplemented('getIssue')
  return Promise.resolve(null)
}

// ── Sessions ────────────────────────────────────────────────────────

type WorkerSessionRow = {
  id: string
  linear_issue_id: string | null
  linear_issue_identifier: string | null
  linear_issue_title: string | null
  status: string
  started_at: string | null
  completed_at: string | null
  triggered_by: string | null
  source?: string | null
  workflow_name?: string | null
  team: string | null
  repo: string | null
}

export async function getSessions(params?: {
  issueIdentifier?: string
  limit?: number
  projectId?: number
}): Promise<SessionsPayload> {
  const search = new URLSearchParams()
  if (params?.limit) search.set('limit', String(params.limit))
  // The Worker doesn't yet filter by issue_identifier or project_id; the
  // results below get filtered client-side as a fallback so callers
  // still see the right rows.
  const query = search.toString()
  const raw = await requestJson<{ sessions: WorkerSessionRow[] }>(
    `/dashboard/api/sessions${query ? `?${query}` : ''}`,
  )

  let sessions = raw.sessions
  if (params?.issueIdentifier) {
    const wanted = params.issueIdentifier
    sessions = sessions.filter(
      (s) =>
        s.linear_issue_identifier === wanted ||
        s.linear_issue_id === wanted ||
        s.id === wanted,
    )
  }

  return {
    sessions: sessions.map((s) => ({
      id: stableHash(s.id),
      issue_identifier: s.linear_issue_identifier,
      issue_title: s.linear_issue_title,
      session_id: s.id,
      detail_session_id: s.id,
      status: s.status,
      started_at: s.started_at,
      ended_at: s.completed_at,
      turn_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      worker_host: null,
      error: null,
      error_category: null,
      workflow_name: s.workflow_name ?? s.triggered_by ?? (s.source === 'api' ? 'API invocation' : null),
      github_branch: null,
      github_repo: s.repo,
      project_name: s.team,
    })),
  }
}

export type SessionDebugMessage =
  | string
  // Modern shape produced from `agent_session_events` rows by the
  // Worker: see workers/linear-agent/src/routes/dashboard.ts.
  | { type?: string; timestamp?: string; body?: string | null }
  // Legacy shape, still produced for older sessions where the events
  // table is empty and we fall back to the `messages` JSON blob.
  | { role?: string; content?: string; timestamp?: string }

export type WorkerSessionDebug = {
  id: string
  linear_issue_id: string | null
  linear_issue_identifier: string | null
  linear_issue_title: string | null
  status: string
  // Worker normalizes persisted epoch seconds to ISO strings before
  // returning dashboard payloads.
  started_at: string | null
  completed_at: string | null
  triggered_by: string | null
  team: string | null
  repo: string | null
  prompt: string | null
  config_snapshot: Record<string, unknown> | null
  stderr: string | null
  dispatcher_logs: unknown[]
  messages: SessionDebugMessage[]
  error: string | null
}

export function getSessionDebug(sessionId: string): Promise<WorkerSessionDebug> {
  return requestJson<WorkerSessionDebug>(
    `/dashboard/api/sessions/${encodeURIComponent(sessionId)}/debug`,
  )
}

export async function getSessionTimeline(issueIdentifier: string): Promise<MessagesPayload> {
  // Worker only exposes `/dashboard/api/sessions/:sessionId/debug`. The
  // Symphony route takes an issue identifier and returns all sessions
  // for that issue. We approximate: list sessions, filter to that
  // issue, hydrate each via the debug endpoint.
  const all = await getSessions({ issueIdentifier })
  const sessions = await Promise.all(
    all.sessions.map(async (s) => hydrateSession(s.session_id ?? '', s)),
  )

  return {
    issue_identifier: issueIdentifier,
    issue_id: sessions[0]?.id != null ? String(sessions[0].id) : null,
    issue_title: sessions[0]?.issue_title ?? null,
    status: sessions[0]?.status ?? 'unknown',
    active_session_id: sessions.find((s) => s.live)?.session_id ?? null,
    sessions,
  }
}

async function hydrateSession(
  sessionId: string,
  base: SessionsPayload['sessions'][number],
): Promise<TimelineSession> {
  if (!sessionId) {
    return toTimelineSession(base, [], false)
  }
  try {
    const debug = await requestJson<WorkerSessionDebug>(
      `/dashboard/api/sessions/${encodeURIComponent(sessionId)}/debug`,
    )
    const live = debug.status === 'running'
    return toTimelineSession(base, debug.messages ?? [], live, debug.error)
  } catch {
    return toTimelineSession(base, [], false)
  }
}

function toTimelineSession(
  base: SessionsPayload['sessions'][number],
  rawMessages: WorkerSessionDebug['messages'],
  live: boolean,
  error: string | null = null,
): TimelineSession {
  const messages: TimelineMessage[] = rawMessages.map((m, i) => {
    if (typeof m === 'string') {
      return { id: i, timestamp: null, type: 'message', content: m, metadata: {} }
    }
    const modern = m as { type?: string; body?: string | null; timestamp?: string }
    const legacy = m as { role?: string; content?: string; timestamp?: string }
    return {
      id: i,
      timestamp: modern.timestamp ?? legacy.timestamp ?? null,
      type: modern.type ?? legacy.role ?? 'message',
      content: modern.body ?? legacy.content ?? '',
      metadata: {},
    }
  })

  return {
    id: base.id,
    issue_identifier: base.issue_identifier,
    issue_title: base.issue_title,
    session_id: base.session_id ?? '',
    status: base.status,
    started_at: base.started_at,
    ended_at: base.ended_at,
    turn_count: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    worker_host: base.worker_host,
    error,
    error_category: null,
    workflow_name: base.workflow_name,
    live,
    messages,
  }
}

// ── Projects ────────────────────────────────────────────────────────

type WorkerProject = {
  id: number
  org_id: string
  linear_team_id: string
  linear_team_name: string
  repo_url: string
  default_branch: string
  engine: string
  model: string | null
  max_turns: number
  scope: string | null
  system_prompt_override: string | null
  created_at: string
  updated_at: string
}

function workerToProject(p: WorkerProject): Project {
  return {
    id: p.id,
    name: p.linear_team_name || p.linear_team_id,
    linear_project_slug: p.linear_team_id,
    linear_organization_slug: p.org_id,
    linear_filter_by: 'team',
    linear_label_name: null,
    github_repo: p.repo_url,
    github_branch: p.default_branch,
    workspace_root: null,
    env_vars: p.system_prompt_override,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }
}

function projectBodyToWorker(body: ProjectBody): Record<string, unknown> {
  const repo = body.github_repo?.trim() ?? ''
  const repoUrl = repo
    ? /^https?:\/\//.test(repo)
      ? repo
      : `https://github.com/${repo.replace(/^\/+|\/+$/g, '')}`
    : ''
  return {
    linear_team_id: body.linear_project_slug ?? '',
    linear_team_name: body.name,
    repo_url: repoUrl,
    default_branch: body.github_branch ?? 'main',
    system_prompt_override: body.env_vars ?? null,
  }
}

export async function getProjects(): Promise<{ projects: Project[] }> {
  const raw = await requestJson<{ projects: WorkerProject[] }>('/dashboard/api/projects')
  return { projects: raw.projects.map(workerToProject) }
}

export async function createProject(body: ProjectBody): Promise<{ project: Project }> {
  const raw = await requestJson<{ project: WorkerProject }>('/dashboard/api/projects', {
    method: 'POST',
    body: JSON.stringify(projectBodyToWorker(body)),
  })
  return { project: workerToProject(raw.project) }
}

export async function updateProject(id: number, body: ProjectBody): Promise<{ project: Project }> {
  const raw = await requestJson<{ project: WorkerProject }>(`/dashboard/api/projects/${id}`, {
    method: 'PUT',
    body: JSON.stringify(projectBodyToWorker(body)),
  })
  return { project: workerToProject(raw.project) }
}

export function deleteProject(id: number) {
  return requestJson<{ ok: boolean }>(`/dashboard/api/projects/${id}`, { method: 'DELETE' })
}

// ── Webhook events (closed-loop test view) ──────────────────────────

export type WebhookEvent = {
  id: string
  received_at: number
  organization_id: string | null
  source_id: string | null
  webhook_id: string | null
  envelope_type: string
  envelope_action: string | null
  signature_ok: boolean
  deduped: boolean
  matched_workflow_id: string | null
  matched_trigger_id: string | null
  dispatched_action: string
  agent_session_id: string | null
  error: string | null
  latency_ms: number
  event_summary: string | null
  raw_body: string | null
  raw_body_truncated?: boolean
}

export type WebhookListParams = {
  limit?: number
  envelope?: string
  dispatchedAction?: string
  sourceId?: string
}

export async function getWebhooks(
  params?: WebhookListParams,
): Promise<{ webhooks: WebhookEvent[] }> {
  const qs = new URLSearchParams()
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.envelope) qs.set('envelope', params.envelope)
  if (params?.dispatchedAction)
    qs.set('dispatched_action', params.dispatchedAction)
  if (params?.sourceId) qs.set('source_id', params.sourceId)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return requestJson<{ webhooks: WebhookEvent[] }>(`/api/v1/webhooks${suffix}`)
}

export async function getWebhook(id: string): Promise<{ webhook: WebhookEvent }> {
  return requestJson<{ webhook: WebhookEvent }>(`/api/v1/webhooks/${id}`)
}

// ── Settings ────────────────────────────────────────────────────────

export function getSettings(): Promise<SettingsPayload> {
  return requestJson<SettingsPayload>('/dashboard/api/settings')
}

export function upsertSetting(
  key: string,
  value: string,
): Promise<{ setting: Setting }> {
  return requestJson<{ setting: Setting }>(
    `/dashboard/api/settings/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ value }),
    },
  )
}

export function deleteSetting(key: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/dashboard/api/settings/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  )
}

// ── API tokens (used by MCP + CI) ───────────────────────────────────

export type ApiTokenScope = 'read' | 'write' | 'admin'

export type ApiToken = {
  id: string
  name: string
  scopes: ApiTokenScope[]
  created_at: number
  last_used_at: number | null
}

// `plaintext` only present on the create response; lost forever once
// the modal closes.
export type ApiTokenWithPlaintext = ApiToken & { plaintext: string }

export function listApiTokens(): Promise<{ tokens: ApiToken[] }> {
  return requestJson<{ tokens: ApiToken[] }>('/api/v1/api-tokens')
}

export function createApiToken(
  name: string,
  scopes: ApiTokenScope[],
): Promise<{ token: ApiTokenWithPlaintext }> {
  return requestJson<{ token: ApiTokenWithPlaintext }>('/api/v1/api-tokens', {
    method: 'POST',
    body: JSON.stringify({ name, scopes }),
  })
}

export function deleteApiToken(id: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/v1/api-tokens/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
}

// ── OAuth status (derived from /dashboard/api/integrations) ─────────

export type OAuthStatus = {
  status: 'connected' | 'expired' | 'disconnected' | 'reconnect_required'
  expires_at: string | null
  credentials_source: 'env' | 'store' | 'none'
  proxy_available: boolean
  last_refresh_error?: string | null
  last_refresh_at?: string | null
}

export type Integrations = {
  linear: { connected: boolean; email: string | null }
  github: {
    connected: boolean
    repo_selection: 'all' | 'selected' | null
    repo_count: number | null
  }
  anthropic: { configured: boolean }
  openai: { configured: boolean }
  cf_workers_ai: { configured: boolean }
  github_app_settings_url: string | null
}

export type WebhookSource = {
  id: string
  organization_id: string
  kind: 'github'
  name: string
  config: Record<string, unknown>
  inbound_url: string
  secret?: string
  created_at: number
  updated_at: number
}

export function listWebhookSources(): Promise<{ webhook_sources: WebhookSource[] }> {
  return requestJson<{ webhook_sources: WebhookSource[] }>('/api/v1/webhook-sources')
}

export function createWebhookSource(input: {
  kind: 'github'
  name: string
  config?: Record<string, unknown>
}): Promise<{ webhook_source: WebhookSource }> {
  return requestJson<{ webhook_source: WebhookSource }>('/api/v1/webhook-sources', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function getIntegrations(): Promise<Integrations> {
  return requestJson<Integrations>('/dashboard/api/integrations')
}

async function fetchIntegrations(): Promise<Integrations> {
  return getIntegrations()
}

export async function getOAuthStatus(): Promise<OAuthStatus> {
  const ints = await fetchIntegrations()
  return {
    status: ints.linear.connected ? 'connected' : 'disconnected',
    expires_at: null,
    credentials_source: ints.linear.connected ? 'store' : 'none',
    proxy_available: false,
  }
}

export type OAuthAuthorizeResponse = {
  authorize_url: string
  flow: 'direct' | 'proxy'
  state?: string
}

export function getOAuthAuthorizeUrl(): Promise<OAuthAuthorizeResponse> {
  // Linear Agent install flow — must be hit while signed in with an
  // active org (Worker route validates).
  return Promise.resolve({ authorize_url: '/linear/agent-install', flow: 'direct' })
}

export async function revokeOAuth(): Promise<{ status: string }> {
  await fetch('/linear/agent-install/revoke', {
    method: 'POST',
    credentials: 'same-origin',
  })
  return { status: 'revoked' }
}

export async function getGitHubOAuthStatus(): Promise<OAuthStatus> {
  const ints = await fetchIntegrations()
  return {
    status: ints.github.connected ? 'connected' : 'disconnected',
    expires_at: null,
    credentials_source: ints.github.connected ? 'store' : 'none',
    proxy_available: false,
  }
}

export function getGitHubOAuthAuthorizeUrl(): Promise<OAuthAuthorizeResponse> {
  return Promise.resolve({ authorize_url: '/github/install', flow: 'direct' })
}

export function revokeGitHubOAuth(): Promise<{ status: string }> {
  warnUnimplemented('revokeGitHubOAuth')
  return Promise.resolve({ status: 'noop' })
}

// ── Linear projects / GitHub repos search (not yet routed) ──────────

export type LinearProject = {
  id: string
  name: string
  slug_id: string
  slug: string
  url: string
  state: string
  organization_slug: string | null
  team_id: string | null
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

export function searchLinearProjects(query: string): Promise<{ projects: LinearProject[] }> {
  const qs = new URLSearchParams({ q: query }).toString()
  return requestJson<{ projects: LinearProject[] }>(`/dashboard/api/linear/projects?${qs}`)
}

export function searchGitHubRepos(query: string): Promise<{ repos: GitHubRepo[] }> {
  const qs = new URLSearchParams({ q: query }).toString()
  return requestJson<{ repos: GitHubRepo[] }>(`/dashboard/api/github/repos?${qs}`)
}

// ── Proxy (does not apply on Workers — always disabled) ─────────────

export type ProxyStatus = {
  enabled: boolean
  instance_url: string | null
  linear_org_id: string | null
}

export function getProxyStatus(): Promise<ProxyStatus> {
  return Promise.resolve({ enabled: false, instance_url: null, linear_org_id: null })
}

export function proxyHealthCheck() {
  return Promise.resolve({ ok: false, error: 'proxy disabled on Worker' })
}

export function proxyRegister() {
  return Promise.resolve({ ok: false })
}

export type ProxyPingResult = {
  proxy: { ok: boolean; error?: string }
  webhook: {
    ok: boolean
    registered?: boolean
    instance_url?: string
    error?: string
    response_body?: string
    response_server?: string
  }
}

export function proxyPing(): Promise<ProxyPingResult> {
  return Promise.resolve({
    proxy: { ok: false, error: 'proxy disabled on Worker' },
    webhook: { ok: false, error: 'proxy disabled on Worker' },
  })
}

export type ProxyPollResponse = { status: 'complete' | 'pending' }

export function pollLinearProxyOAuth(): Promise<ProxyPollResponse> {
  return Promise.resolve({ status: 'complete' })
}

export function pollGitHubProxyOAuth(): Promise<ProxyPollResponse> {
  return Promise.resolve({ status: 'complete' })
}

// ── Timeline merge helpers (preserved verbatim) ─────────────────────

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
    const lastIndex = nextMessages.findLastIndex(
      (message) => String(message.id) === String(incoming.id),
    )

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
    linear_filter_by: 'team',
    linear_label_name: null,
    github_repo: null,
    github_branch: 'main',
    workspace_root: null,
    env_vars: null,
  }
}
