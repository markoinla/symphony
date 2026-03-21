import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from '@tanstack/react-router'
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import {
  ApiError,
  createProject,
  deleteProject,
  deleteSetting,
  emptyProject,
  getIssue,
  getProjects,
  getSessionTimeline,
  getSessions,
  getSettings,
  getState,
  mergeTimelineMessage,
  type MessagesPayload,
  type Project,
  type SessionsPayload,
  type StatePayload,
  type TimelineMessage,
  type TimelineSession,
  updateProject,
  updateTimelineMessage,
  upsertSetting,
} from './lib/api'
import { useDashboardStream, useSessionStream } from './lib/streams'
import {
  cn,
  formatClock,
  formatDateTime,
  formatNumber,
  formatRuntimeFromSeconds,
  groupConsecutiveByType,
  runtimeSince,
} from './lib/utils'
import { Badge, Button, Card, Input, Textarea } from './components/ui'

type DashboardGroup = {
  label: string
  workflowName: string | null
  running: StatePayload['running']
  retrying: StatePayload['retrying']
}

type SessionEntry =
  | TimelineMessage
  | {
      type: 'tool_call_group'
      items: TimelineMessage[]
    }

type ProjectDraft = ReturnType<typeof emptyProject>

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundView,
})

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardView,
})

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/session/$issueIdentifier',
  component: SessionView,
})

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  component: HistoryView,
})

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsView,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsView,
})

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  sessionRoute,
  historyRoute,
  projectsRoute,
  settingsRoute,
])

const router = createRouter({
  routeTree,
  scrollRestoration: true,
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

function RootLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8 lg:px-8">
        <header className="mb-10 border-b border-zinc-800 pb-6">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">
                Symphony
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-50">
                Dashboard
              </h1>
            </div>

            <nav className="flex gap-1">
              <HeaderLink active={pathname === '/'} label="Dashboard" to="/" />
              <HeaderLink
                active={pathname.startsWith('/history')}
                label="History"
                to="/history"
              />
              <HeaderLink
                active={pathname.startsWith('/projects')}
                label="Projects"
                to="/projects"
              />
              <HeaderLink
                active={pathname.startsWith('/settings')}
                label="Settings"
                to="/settings"
              />
            </nav>
          </div>
        </header>

        <main className="flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function HeaderLink({
  active,
  label,
  to,
}: {
  active: boolean
  label: string
  to: string
}) {
  return (
    <Link
      className={cn(
        'rounded-lg px-3.5 py-2 text-sm font-medium transition-colors duration-150',
        active
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-200',
      )}
      to={to}
    >
      {label}
    </Link>
  )
}

function DashboardView() {
  const queryClient = useQueryClient()
  const now = useNow()

  const stateQuery = useQuery({
    queryKey: ['state'],
    queryFn: getState,
  })

  useDashboardStream(
    () => {
      void queryClient.invalidateQueries({ queryKey: ['state'] })
    },
    true,
  )

  if (stateQuery.isPending) {
    return <LoadingPanel title="Loading dashboard" />
  }

  if (stateQuery.isError) {
    return <ErrorPanel title="Dashboard unavailable" detail={formatQueryError(stateQuery.error)} />
  }

  const payload = stateQuery.data
  const groups = buildDashboardGroups(payload)

  return (
    <div className="space-y-8">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Running"
          value={formatNumber(payload.counts.running)}
          helper="Active Codex sessions"
        />
        <StatCard
          label="Retrying"
          value={formatNumber(payload.counts.retrying)}
          helper="Queued for another pass"
        />
        <StatCard
          label="Total Tokens"
          value={formatNumber(payload.codex_totals.total_tokens)}
          helper={`${formatNumber(payload.codex_totals.input_tokens)} in / ${formatNumber(payload.codex_totals.output_tokens)} out`}
        />
        <StatCard
          label="Runtime"
          value={formatRuntimeFromSeconds(payload.codex_totals.seconds_running)}
          helper={`Snapshot ${formatClock(payload.generated_at) || 'just now'}`}
        />
      </section>

      {payload.error ? (
        <ErrorPanel title="Snapshot warning" detail={`${payload.error.code}: ${payload.error.message}`} />
      ) : null}

      <section className="space-y-6">
        {groups.length === 0 ? (
          <Card className="border-dashed border-zinc-700 text-center">
            <p className="text-base font-medium text-zinc-300">No active sessions</p>
            <p className="mt-2 text-sm text-zinc-500">
              New work will appear here as soon as the orchestrator claims tickets.
            </p>
          </Card>
        ) : null}

        {groups.map((group) => (
          <Card key={group.workflowName ?? group.label} className="space-y-6">
            <div className="flex flex-col gap-3 border-b border-zinc-800 pb-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="text-xs font-medium uppercase tracking-[0.1em] text-zinc-500">
                  {group.workflowName ? 'Workflow' : 'Default'}
                </div>
                <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-zinc-100">
                  {group.label}
                </h2>
              </div>
              <div className="flex gap-2">
                <Badge tone="running">{group.running.length} running</Badge>
                <Badge tone="retrying">{group.retrying.length} retrying</Badge>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              {group.running.map((entry) => (
                <div
                  key={`running-${entry.issue_id}`}
                  className="rounded-xl border border-zinc-800 bg-zinc-950 p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <Link
                        className="text-base font-semibold text-zinc-100 transition-colors hover:text-indigo-400"
                        params={{ issueIdentifier: entry.issue_identifier }}
                        to="/session/$issueIdentifier"
                      >
                        {entry.issue_identifier}
                      </Link>
                      <p className="mt-1 text-sm text-zinc-500">{entry.state}</p>
                    </div>
                    <Badge tone="running">Running</Badge>
                  </div>

                  <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                    <MetaItem label="Runtime" value={runtimeSince(entry.started_at, now)} />
                    <MetaItem label="Turns" value={formatNumber(entry.turn_count)} />
                    <MetaItem
                      label="Tokens"
                      value={formatNumber(entry.tokens.total_tokens)}
                      helper={`${formatNumber(entry.tokens.input_tokens)} in / ${formatNumber(entry.tokens.output_tokens)} out`}
                    />
                    <MetaItem label="Worker" value={entry.worker_host ?? 'local'} />
                  </dl>

                  <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm">
                    <div className="font-medium text-zinc-300">Latest activity</div>
                    <div className="mt-1 text-zinc-500">{entry.last_message ?? entry.last_event ?? 'Waiting for new events'}</div>
                    {entry.workspace_path ? (
                      <div className="mt-2 text-xs text-zinc-600">{entry.workspace_path}</div>
                    ) : null}
                  </div>
                </div>
              ))}

              {group.retrying.map((entry) => (
                <div
                  key={`retry-${entry.issue_id}`}
                  className="rounded-xl border border-zinc-800 bg-zinc-950 p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <Link
                        className="text-base font-semibold text-zinc-100 transition-colors hover:text-indigo-400"
                        params={{ issueIdentifier: entry.issue_identifier }}
                        to="/session/$issueIdentifier"
                      >
                        {entry.issue_identifier}
                      </Link>
                      <p className="mt-1 text-sm text-zinc-500">{entry.error ?? 'Retry pending'}</p>
                    </div>
                    <Badge tone="retrying">Retry {entry.attempt}</Badge>
                  </div>

                  <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                    <MetaItem label="Retrying At" value={formatDateTime(entry.due_at)} />
                    <MetaItem label="Worker" value={entry.worker_host ?? 'unassigned'} />
                  </dl>

                  {entry.workspace_path ? (
                    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-xs text-zinc-500">
                      {entry.workspace_path}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </Card>
        ))}
      </section>
    </div>
  )
}

function SessionView() {
  const { issueIdentifier } = sessionRoute.useParams()
  const now = useNow()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [followTail, setFollowTail] = useState(true)
  const [timeline, setTimeline] = useState<MessagesPayload | null>(null)

  const issueQuery = useQuery({
    queryKey: ['issue', issueIdentifier],
    queryFn: () => getIssue(issueIdentifier),
  })

  const timelineQuery = useQuery({
    queryKey: ['timeline', issueIdentifier],
    queryFn: () => getSessionTimeline(issueIdentifier),
  })

  const currentTimeline =
    timeline?.issue_identifier === issueIdentifier ? timeline : timelineQuery.data ?? null
  const currentFollowTail = timeline?.issue_identifier === issueIdentifier ? followTail : true
  const activeIssueId = issueQuery.data?.issue_id ?? currentTimeline?.issue_id

  useSessionStream(
    activeIssueId,
    (payload) => {
      setTimeline((current) => {
        const base =
          current?.issue_identifier === issueIdentifier ? current : timelineQuery.data ?? null

        return base ? mergeTimelineMessage(base, payload as TimelineMessage) : current
      })
    },
    (payload) => {
      setTimeline((current) => {
        const base =
          current?.issue_identifier === issueIdentifier ? current : timelineQuery.data ?? null

        return base ? updateTimelineMessage(base, payload as TimelineMessage) : current
      })
    },
  )

  useEffect(() => {
    if (!currentFollowTail) {
      return
    }

    const element = scrollRef.current

    if (!element) {
      return
    }

    element.scrollTop = element.scrollHeight
  }, [currentFollowTail, currentTimeline])

  const issue = issueQuery.data
  const data = currentTimeline

  if (timelineQuery.isPending) {
    return <LoadingPanel title={`Loading ${issueIdentifier}`} />
  }

  if (timelineQuery.isError) {
    return <ErrorPanel title="Timeline unavailable" detail={formatQueryError(timelineQuery.error)} />
  }

  if (!data) {
    return <ErrorPanel title="Timeline unavailable" detail="The session payload did not load." />
  }

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.1em] text-zinc-500">
              Session
            </p>
            <h2 className="mt-1.5 text-xl font-semibold tracking-tight text-zinc-100">
              {data.issue_identifier}
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-500">
              {data.issue_title ?? 'Historical and live session output for this issue.'}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <StatCard
              label="Status"
              value={titleCase(data.status)}
              helper={issue?.workspace.path ?? 'Workspace path unavailable'}
            />
            <StatCard
              label="Active Runtime"
              value={runtimeForTimeline(data.sessions, now)}
              helper={issue?.workspace.host ?? 'local'}
            />
          </div>
        </div>

        {issue ? (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-zinc-800 pt-4">
            <Badge tone={issue.status === 'retrying' ? 'retrying' : 'running'}>
              {titleCase(issue.status)}
            </Badge>
            <Badge tone="neutral">Restart count {formatNumber(issue.attempts.restart_count)}</Badge>
            {issue.running?.session_id ? <Badge tone="live">Session {issue.running.session_id}</Badge> : null}
          </div>
        ) : null}
      </Card>

      <Card>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold tracking-tight text-zinc-100">Timeline</h3>
            <p className="mt-1 text-sm text-zinc-500">
              Historical sessions stay grouped, while live SSE messages append to the active run.
            </p>
          </div>
          {!currentFollowTail ? (
            <Button
              onClick={() => {
                setFollowTail(true)
                const element = scrollRef.current

                if (element) {
                  element.scrollTop = element.scrollHeight
                }
              }}
              variant="secondary"
            >
              Scroll to latest
            </Button>
          ) : null}
        </div>

        <div
          className="max-h-[70vh] space-y-4 overflow-y-auto pr-1"
          onScroll={(event) => {
            const element = event.currentTarget
            const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
            setFollowTail(distanceFromBottom < 96)
          }}
          ref={scrollRef}
        >
          {data.sessions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-700 px-6 py-10 text-center text-sm text-zinc-500">
              No historical or live messages are available for this issue yet.
            </div>
          ) : null}

          {data.sessions.map((session) => (
            <SessionBlock key={`${session.session_id}-${session.live ? 'live' : session.id ?? 'history'}`} now={now} session={session} />
          ))}
        </div>
      </Card>
    </div>
  )
}

function SessionBlock({ now, session }: { now: number; session: TimelineSession }) {
  const groupedEntries = groupConsecutiveByType(session.messages, 'tool_call') as SessionEntry[]

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex flex-col gap-4 border-b border-zinc-800 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-zinc-200">
              {session.live ? 'Live session' : 'Historical session'}
            </h4>
            <Badge tone={session.live ? 'live' : 'neutral'}>{session.session_id}</Badge>
          </div>
          <p className="mt-1.5 text-sm text-zinc-500">
            Started {formatDateTime(session.started_at)} · {session.live ? runtimeSince(session.started_at, now) : session.status}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {session.turn_count ? <Badge tone="neutral">{session.turn_count} turns</Badge> : null}
          {session.total_tokens ? <Badge tone="neutral">{formatNumber(session.total_tokens)} tokens</Badge> : null}
          {session.error ? <Badge tone="danger">Error</Badge> : null}
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {groupedEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-700 px-4 py-6 text-sm text-zinc-500">
            No captured messages for this session.
          </div>
        ) : null}

        {groupedEntries.map((entry, index) =>
          'items' in entry ? (
            <ToolGroup key={`tool-group-${session.session_id}-${index}`} items={entry.items} />
          ) : (
            <TimelineEntryCard key={`${session.session_id}-${entry.id}`} message={entry} />
          ),
        )}
      </div>
    </section>
  )
}

function TimelineEntryCard({ message }: { message: TimelineMessage }) {
  if (message.type === 'thinking') {
    return (
      <details className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
        <summary className="cursor-pointer list-none text-sm font-medium text-zinc-300">
          Thinking · {formatClock(message.timestamp) || 'live'}
        </summary>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-sm leading-6 text-zinc-500">
          {message.content}
        </pre>
      </details>
    )
  }

  if (message.type === 'reasoning_summary') {
    return (
      <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-indigo-400">Reasoning summary</div>
          <div className="text-xs text-zinc-500">{formatClock(message.timestamp) || 'live'}</div>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-300">{message.content}</p>
      </div>
    )
  }

  if (message.type === 'turn_boundary') {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-2.5 text-xs font-medium text-zinc-500">
        {message.content}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'rounded-lg border p-4',
        message.type === 'error' ? 'border-red-500/20 bg-red-500/5' : 'border-zinc-800 bg-zinc-900',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge tone={messageTone(message.type)}>{messageLabel(message.type)}</Badge>
          <span className="text-xs text-zinc-600">{formatClock(message.timestamp) || 'live'}</span>
        </div>
      </div>
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-sm leading-6 text-zinc-400">
        {message.content}
      </pre>
    </div>
  )
}

function ToolGroup({ items }: { items: TimelineMessage[] }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge tone="retrying">Tool Calls</Badge>
          <span className="text-xs text-zinc-500">{items.length} grouped events</span>
        </div>
        <div className="text-xs text-zinc-600">{formatClock(items.at(-1)?.timestamp) || 'live'}</div>
      </div>

      <div className="mt-3 space-y-2">
        {items.map((item) => {
          const metadata = item.metadata as Record<string, unknown>

          return (
            <div key={String(item.id)} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-medium text-zinc-300">{item.content}</div>
                <Badge tone={toolTone(metadata.status)}>{String(metadata.status ?? 'unknown')}</Badge>
              </div>
              <div className="mt-2 whitespace-pre-wrap font-mono text-xs leading-5 text-zinc-600">
                {formatJson(metadata)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function HistoryView() {
  const sessionsQuery = useQuery({
    queryKey: ['sessions', 'history'],
    queryFn: () => getSessions({ limit: 100 }),
  })

  if (sessionsQuery.isPending) {
    return <LoadingPanel title="Loading session history" />
  }

  if (sessionsQuery.isError) {
    return <ErrorPanel title="History unavailable" detail={formatQueryError(sessionsQuery.error)} />
  }

  const payload = sessionsQuery.data

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-zinc-100">Session history</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Review past runs and jump directly into the retained timeline for a given issue.
        </p>
      </div>

      <div className="space-y-px overflow-hidden rounded-xl border border-zinc-800">
        {payload.sessions.length === 0 ? (
          <div className="bg-zinc-900 px-6 py-10 text-center text-sm text-zinc-500">
            No historical sessions have been persisted yet.
          </div>
        ) : null}

        {payload.sessions.map((session) => (
          <HistoryRow key={session.id} session={session} />
        ))}
      </div>
    </div>
  )
}

function HistoryRow({ session }: { session: SessionsPayload['sessions'][number] }) {
  const issueIdentifier = session.issue_identifier

  return (
    <div className="flex items-center justify-between gap-4 border-b border-zinc-800 bg-zinc-900 px-5 py-4 last:border-b-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {issueIdentifier ? (
            <Link
              className="text-sm font-semibold text-zinc-200 transition-colors hover:text-indigo-400"
              params={{ issueIdentifier }}
              to="/session/$issueIdentifier"
            >
              {issueIdentifier}
            </Link>
          ) : (
            <span className="text-sm font-semibold text-zinc-200">Unknown issue</span>
          )}
          <Badge tone={session.status === 'failed' ? 'danger' : 'neutral'}>{titleCase(session.status)}</Badge>
        </div>
        <p className="mt-1 truncate text-sm text-zinc-500">{session.issue_title ?? 'No title stored'}</p>
        <p className="mt-0.5 text-xs text-zinc-600">
          {formatDateTime(session.started_at)} · {session.worker_host ?? 'local'} · {formatNumber(session.total_tokens)} tokens
        </p>
      </div>

      {issueIdentifier ? (
        <Link
          className="shrink-0 rounded-lg border border-zinc-700 px-3.5 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
          params={{ issueIdentifier }}
          to="/session/$issueIdentifier"
        >
          Open
        </Link>
      ) : null}
    </div>
  )
}

function ProjectsView() {
  const queryClient = useQueryClient()
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
  })

  const [draft, setDraft] = useState<ProjectDraft>(emptyProject)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  const saveMutation = useMutation({
    mutationFn: (values: { id: number | null; body: ProjectDraft }) =>
      values.id === null ? createProject(values.body) : updateProject(values.id, values.body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      setFeedback(editingId === null ? 'Project created.' : 'Project updated.')
      setDraft(emptyProject())
      setEditingId(null)
    },
    onError: (error: unknown) => {
      setFeedback(formatQueryError(error))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      setFeedback('Project deleted.')
      setDraft(emptyProject())
      setEditingId(null)
    },
    onError: (error: unknown) => {
      setFeedback(formatQueryError(error))
    },
  })

  return (
    <div className="grid gap-6 xl:grid-cols-[1.2fr,0.8fr]">
      <Card className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-zinc-100">Projects</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Map Linear projects to GitHub repos and per-project workspace defaults.
          </p>
        </div>

        {feedback ? (
          <div className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-300">
            {feedback}
          </div>
        ) : null}

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setFeedback(null)
            void saveMutation.mutateAsync({ id: editingId, body: normalizeProjectDraft(draft) })
          }}
        >
          <Field label="Project name">
            <Input
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="Agent Workflow"
              required
              value={draft.name}
            />
          </Field>

          <div className="grid gap-4 lg:grid-cols-2">
            <Field label="Linear project slug or URL">
              <Input
                onChange={(event) =>
                  setDraft((current) => ({ ...current, linear_project_slug: event.target.value }))
                }
                placeholder="agent-workflow"
                value={draft.linear_project_slug ?? ''}
              />
            </Field>

            <Field label="Linear organization slug">
              <Input
                onChange={(event) =>
                  setDraft((current) => ({ ...current, linear_organization_slug: event.target.value }))
                }
                placeholder="marko-la"
                value={draft.linear_organization_slug ?? ''}
              />
            </Field>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Field label="Filter mode">
              <select
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-sm text-zinc-200 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, linear_filter_by: event.target.value }))
                }
                value={draft.linear_filter_by ?? 'project'}
              >
                <option value="project">Project</option>
                <option value="label">Label</option>
              </select>
            </Field>

            <Field label="Label name">
              <Input
                onChange={(event) =>
                  setDraft((current) => ({ ...current, linear_label_name: event.target.value }))
                }
                placeholder="symphony"
                value={draft.linear_label_name ?? ''}
              />
            </Field>
          </div>

          <Field label="GitHub repo">
            <Input
              onChange={(event) => setDraft((current) => ({ ...current, github_repo: event.target.value }))}
              placeholder="markoinla/symphony"
              value={draft.github_repo ?? ''}
            />
          </Field>

          <Field label="Workspace root">
            <Input
              onChange={(event) =>
                setDraft((current) => ({ ...current, workspace_root: event.target.value }))
              }
              placeholder="~/code/symphony-workspaces"
              value={draft.workspace_root ?? ''}
            />
          </Field>

          <Field label="Environment variables">
            <Textarea
              onChange={(event) => setDraft((current) => ({ ...current, env_vars: event.target.value }))}
              placeholder="NAME=value"
              value={draft.env_vars ?? ''}
            />
          </Field>

          <div className="flex flex-wrap gap-3">
            <Button disabled={saveMutation.isPending} type="submit">
              {editingId === null ? 'Create project' : 'Save changes'}
            </Button>
            {editingId !== null ? (
              <Button
                onClick={() => {
                  setDraft(emptyProject())
                  setEditingId(null)
                  setFeedback(null)
                }}
                type="button"
                variant="secondary"
              >
                Cancel edit
              </Button>
            ) : null}
          </div>
        </form>
      </Card>

      <Card className="space-y-4">
        <div>
          <h3 className="text-base font-semibold tracking-tight text-zinc-100">Current mappings</h3>
          <p className="mt-1 text-sm text-zinc-500">Each project card represents one stored mapping.</p>
        </div>

        {projectsQuery.isPending ? <LoadingPanel title="Loading projects" compact /> : null}
        {projectsQuery.isError ? (
          <ErrorPanel detail={formatQueryError(projectsQuery.error)} title="Projects unavailable" />
        ) : null}

        <div className="space-y-2">
          {projectsQuery.data?.projects.map((project: Project) => (
            <div
              className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
              key={project.id}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-200">{project.name}</div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {project.github_repo ?? 'No repo configured'}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      setDraft(projectToDraft(project))
                      setEditingId(project.id)
                      setFeedback(null)
                    }}
                    type="button"
                    variant="secondary"
                  >
                    Edit
                  </Button>
                  <Button
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      setFeedback(null)
                      void deleteMutation.mutateAsync(project.id)
                    }}
                    type="button"
                    variant="danger"
                  >
                    Delete
                  </Button>
                </div>
              </div>
              <div className="mt-3 font-mono text-xs leading-5 text-zinc-600">
                {formatJson({
                  linear_project_slug: project.linear_project_slug,
                  linear_organization_slug: project.linear_organization_slug,
                  linear_filter_by: project.linear_filter_by,
                  linear_label_name: project.linear_label_name,
                  workspace_root: project.workspace_root,
                })}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

function LinearApiKeyCard() {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  })

  const existing = settingsQuery.data?.settings.find(
    (s: { key: string; value: string }) => s.key === 'tracker.api_key',
  )

  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  const saveMutation = useMutation({
    mutationFn: (value: string) => upsertSetting('tracker.api_key', value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback('Linear API key saved.')
      setApiKey('')
      setShowKey(false)
    },
    onError: (error: unknown) => {
      setFeedback(formatQueryError(error))
    },
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteSetting('tracker.api_key'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback('Linear API key removed.')
      setApiKey('')
    },
    onError: (error: unknown) => {
      setFeedback(formatQueryError(error))
    },
  })

  const maskedValue = existing
    ? existing.value.slice(0, 8) + '\u2022'.repeat(Math.max(0, existing.value.length - 8))
    : null

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-zinc-100">Linear API Key</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Required to connect Symphony to Linear. Get a personal API key from Linear Settings &rarr; Security &amp; access &rarr; Personal API keys.
        </p>
      </div>

      {feedback ? (
        <div className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-300">
          {feedback}
        </div>
      ) : null}

      {existing ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <div className="flex items-center justify-between gap-3">
            <code className="text-sm text-zinc-400 break-all">
              {showKey ? existing.value : maskedValue}
            </code>
            <div className="flex gap-2">
              <Button onClick={() => setShowKey(!showKey)} type="button" variant="secondary">
                {showKey ? 'Hide' : 'Reveal'}
              </Button>
              <Button
                disabled={removeMutation.isPending}
                onClick={() => {
                  setFeedback(null)
                  void removeMutation.mutateAsync()
                }}
                type="button"
                variant="danger"
              >
                Remove
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          setFeedback(null)
          void saveMutation.mutateAsync(apiKey.trim())
        }}
      >
        <Field label={existing ? 'Replace API key' : 'API key'}>
          <Input
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="lin_api_..."
            required
            type="password"
            value={apiKey}
          />
        </Field>
        <div>
          <Button disabled={saveMutation.isPending || !apiKey.trim()} type="submit">
            {existing ? 'Update key' : 'Save key'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function SettingsView() {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  })

  const [keyValue, setKeyValue] = useState('')
  const [settingValue, setSettingValue] = useState('')
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  const saveMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => upsertSetting(key, value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback(editingKey === null ? 'Setting saved.' : 'Setting updated.')
      setKeyValue('')
      setSettingValue('')
      setEditingKey(null)
    },
    onError: (error: unknown) => {
      setFeedback(formatQueryError(error))
    },
  })

  const removeMutation = useMutation({
    mutationFn: deleteSetting,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback('Setting deleted.')
      setKeyValue('')
      setSettingValue('')
      setEditingKey(null)
    },
    onError: (error: unknown) => {
      setFeedback(formatQueryError(error))
    },
  })

  return (
    <div className="space-y-6">
    <LinearApiKeyCard />
    <div className="grid gap-6 xl:grid-cols-[0.9fr,1.1fr]">
      <Card className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-zinc-100">Settings</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Manage global key-value settings used to build the workflow config overlay.
          </p>
        </div>

        {feedback ? (
          <div className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-300">
            {feedback}
          </div>
        ) : null}

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setFeedback(null)
            void saveMutation.mutateAsync({ key: keyValue.trim(), value: settingValue })
          }}
        >
          <Field label="Key">
            <Input
              onChange={(event) => setKeyValue(event.target.value)}
              placeholder="workspace.root"
              required
              value={keyValue}
            />
          </Field>
          <Field label="Value">
            <Textarea
              onChange={(event) => setSettingValue(event.target.value)}
              placeholder="~/code/symphony-workspaces"
              required
              value={settingValue}
            />
          </Field>

          <div className="flex flex-wrap gap-3">
            <Button disabled={saveMutation.isPending} type="submit">
              {editingKey === null ? 'Save setting' : 'Update setting'}
            </Button>
            {editingKey !== null ? (
              <Button
                onClick={() => {
                  setEditingKey(null)
                  setKeyValue('')
                  setSettingValue('')
                  setFeedback(null)
                }}
                type="button"
                variant="secondary"
              >
                Cancel edit
              </Button>
            ) : null}
          </div>
        </form>
      </Card>

      <Card className="space-y-4">
        <div>
          <h3 className="text-base font-semibold tracking-tight text-zinc-100">Stored settings</h3>
          <p className="mt-1 text-sm text-zinc-500">
            Click edit to reuse an existing key without retyping it.
          </p>
        </div>

        {settingsQuery.isPending ? <LoadingPanel title="Loading settings" compact /> : null}
        {settingsQuery.isError ? (
          <ErrorPanel detail={formatQueryError(settingsQuery.error)} title="Settings unavailable" />
        ) : null}

        <div className="space-y-2">
          {settingsQuery.data?.settings.map((setting: { key: string; value: string }) => (
            <div
              className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
              key={setting.key}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-zinc-200">{setting.key}</div>
                  <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-zinc-500">
                    {setting.value}
                  </pre>
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      setEditingKey(setting.key)
                      setKeyValue(setting.key)
                      setSettingValue(setting.value)
                      setFeedback(null)
                    }}
                    type="button"
                    variant="secondary"
                  >
                    Edit
                  </Button>
                  <Button
                    disabled={removeMutation.isPending}
                    onClick={() => {
                      setFeedback(null)
                      void removeMutation.mutateAsync(setting.key)
                    }}
                    type="button"
                    variant="danger"
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
    </div>
  )
}

function NotFoundView() {
  return (
    <Card className="mx-auto max-w-2xl text-center">
      <p className="text-xs font-medium uppercase tracking-[0.1em] text-zinc-500">Not found</p>
      <h2 className="mt-2 text-lg font-semibold tracking-tight text-zinc-100">
        The requested dashboard route does not exist.
      </h2>
      <p className="mt-2 text-sm text-zinc-500">
        Phoenix will serve the SPA shell for valid client routes only.
      </p>
    </Card>
  )
}

function StatCard({
  helper,
  label,
  value,
}: {
  helper: string
  label: string
  value: string
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="text-xs font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">{value}</div>
      <div className="mt-1 text-sm text-zinc-600">{helper}</div>
    </div>
  )
}

function MetaItem({
  helper,
  label,
  value,
}: {
  helper?: string
  label: string
  value: string
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2.5">
      <dt className="text-xs font-medium text-zinc-500">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-zinc-200">{value}</dd>
      {helper ? <div className="mt-0.5 text-xs text-zinc-600">{helper}</div> : null}
    </div>
  )
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="grid gap-1.5 text-sm font-medium text-zinc-400">
      <span>{label}</span>
      {children}
    </label>
  )
}

function LoadingPanel({ compact = false, title }: { compact?: boolean; title: string }) {
  return (
    <Card className={cn('text-center', compact && 'p-4')}>
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      <p className="mt-1 text-sm text-zinc-600">Fetching the latest payload from Phoenix.</p>
    </Card>
  )
}

function ErrorPanel({ detail, title }: { detail: string; title: string }) {
  return (
    <Card className="border-red-500/20 bg-red-500/5">
      <p className="text-sm font-medium text-red-400">{title}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-red-300/80">{detail}</p>
    </Card>
  )
}

function useNow(intervalMs = 1_000) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, intervalMs)

    return () => {
      window.clearInterval(timer)
    }
  }, [intervalMs])

  return now
}

function buildDashboardGroups(payload: StatePayload): DashboardGroup[] {
  const groups = new Map<string, DashboardGroup>()

  for (const entry of payload.running) {
    const key = entry.workflow_name ?? 'default'
    const group = groups.get(key) ?? {
      label: humanizeWorkflowName(entry.workflow_name),
      workflowName: entry.workflow_name ?? null,
      running: [],
      retrying: [],
    }

    group.running.push(entry)
    groups.set(key, group)
  }

  for (const entry of payload.retrying) {
    const key = entry.workflow_name ?? 'default'
    const group = groups.get(key) ?? {
      label: humanizeWorkflowName(entry.workflow_name),
      workflowName: entry.workflow_name ?? null,
      running: [],
      retrying: [],
    }

    group.retrying.push(entry)
    groups.set(key, group)
  }

  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label))
}

function humanizeWorkflowName(name: string | undefined) {
  if (!name) {
    return 'Default project'
  }

  const [base, maybeProjectId] = name.split(':')

  if (maybeProjectId) {
    return `${base} · project ${maybeProjectId}`
  }

  return base
}

function runtimeForTimeline(sessions: TimelineSession[], now: number) {
  const active = sessions.findLast((session: TimelineSession) => session.live)

  if (!active) {
    return 'Inactive'
  }

  return runtimeSince(active.started_at, now)
}

function messageTone(type: string): 'neutral' | 'danger' | 'live' {
  switch (type) {
    case 'error':
      return 'danger'
    case 'response':
      return 'live'
    default:
      return 'neutral'
  }
}

function messageLabel(type: string) {
  switch (type) {
    case 'response':
      return 'Response'
    case 'error':
      return 'Error'
    default:
      return titleCase(type)
  }
}

function toolTone(status: unknown): 'neutral' | 'retrying' | 'danger' | 'live' {
  switch (status) {
    case 'completed':
      return 'live'
    case 'failed':
      return 'danger'
    case 'running':
      return 'retrying'
    default:
      return 'neutral'
  }
}

function titleCase(value: string) {
  return value
    .replaceAll('_', ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function normalizeProjectDraft(project: ProjectDraft): ProjectDraft {
  return {
    name: project.name.trim(),
    linear_project_slug: nilIfBlank(project.linear_project_slug),
    linear_organization_slug: nilIfBlank(project.linear_organization_slug),
    linear_filter_by: project.linear_filter_by ?? 'project',
    linear_label_name: nilIfBlank(project.linear_label_name),
    github_repo: nilIfBlank(project.github_repo),
    workspace_root: nilIfBlank(project.workspace_root),
    env_vars: nilIfBlank(project.env_vars),
  }
}

function projectToDraft(project: Project): ProjectDraft {
  return {
    name: project.name,
    linear_project_slug: project.linear_project_slug,
    linear_organization_slug: project.linear_organization_slug,
    linear_filter_by: project.linear_filter_by,
    linear_label_name: project.linear_label_name,
    github_repo: project.github_repo,
    workspace_root: project.workspace_root,
    env_vars: project.env_vars,
  }
}

function nilIfBlank(value: string | null) {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function formatQueryError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.payload?.error?.details) {
      return `${error.message}\n${formatJson(error.payload.error.details)}`
    }

    return error.message
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error'
}
