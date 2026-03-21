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
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

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

function useTheme() {
  const [dark, setDark] = useState(() => {
    if (typeof window === 'undefined') return true
    const stored = localStorage.getItem('theme')
    if (stored) return stored === 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }, [dark])

  const toggle = useCallback(() => setDark((d) => !d), [])

  return { dark, toggle }
}

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
  const { dark, toggle } = useTheme()

  return (
    <div className="min-h-screen bg-th-bg text-th-text-2 transition-colors duration-200">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8 lg:px-8">
        <header className="mb-10 border-b border-th-border pb-6">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-th-text-3">
                Symphony
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-th-text-1">
                Dashboard
              </h1>
            </div>

            <div className="flex items-center gap-1">
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

              <div className="ml-2 h-5 w-px bg-th-border" />

              <button
                aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
                className="ml-2 flex h-8 w-8 items-center justify-center rounded-lg text-th-text-3 transition-colors hover:bg-th-muted hover:text-th-text-1"
                onClick={toggle}
                type="button"
              >
                {dark ? (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="5" />
                    <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                )}
              </button>
            </div>
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
          ? 'bg-th-muted text-th-text-1'
          : 'text-th-text-3 hover:text-th-text-1',
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
          <Card className="border-dashed border-th-border-muted text-center">
            <p className="text-base font-medium text-th-text-2">No active sessions</p>
            <p className="mt-2 text-sm text-th-text-3">
              New work will appear here as soon as the orchestrator claims tickets.
            </p>
          </Card>
        ) : null}

        {groups.map((group) => (
          <Card key={group.workflowName ?? group.label} className="space-y-6">
            <div className="flex flex-col gap-3 border-b border-th-border pb-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="text-xs font-medium uppercase tracking-[0.1em] text-th-text-3">
                  {group.workflowName ? 'Workflow' : 'Default'}
                </div>
                <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-th-text-1">
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
                  className="rounded-xl border border-th-border bg-th-inset p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <Link
                        className="text-base font-semibold text-th-text-1 transition-colors hover:text-th-accent"
                        params={{ issueIdentifier: entry.issue_identifier }}
                        to="/session/$issueIdentifier"
                      >
                        {entry.issue_identifier}
                      </Link>
                      <p className="mt-1 text-sm text-th-text-3">{entry.state}</p>
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

                  <div className="mt-4 rounded-lg border border-th-border bg-th-surface px-4 py-3 text-sm">
                    <div className="font-medium text-th-text-2">Latest activity</div>
                    <div className="mt-1 text-th-text-3">{entry.last_message ?? entry.last_event ?? 'Waiting for new events'}</div>
                    {entry.workspace_path ? (
                      <div className="mt-2 text-xs text-th-text-4">{entry.workspace_path}</div>
                    ) : null}
                  </div>
                </div>
              ))}

              {group.retrying.map((entry) => (
                <div
                  key={`retry-${entry.issue_id}`}
                  className="rounded-xl border border-th-border bg-th-inset p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <Link
                        className="text-base font-semibold text-th-text-1 transition-colors hover:text-th-accent"
                        params={{ issueIdentifier: entry.issue_identifier }}
                        to="/session/$issueIdentifier"
                      >
                        {entry.issue_identifier}
                      </Link>
                      <p className="mt-1 text-sm text-th-text-3">{entry.error ?? 'Retry pending'}</p>
                    </div>
                    <Badge tone="retrying">Retry {entry.attempt}</Badge>
                  </div>

                  <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                    <MetaItem label="Retrying At" value={formatDateTime(entry.due_at)} />
                    <MetaItem label="Worker" value={entry.worker_host ?? 'unassigned'} />
                  </dl>

                  {entry.workspace_path ? (
                    <div className="mt-4 rounded-lg border border-th-border bg-th-surface px-4 py-3 text-xs text-th-text-3">
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
    <div className="flex flex-col" style={{ height: 'calc(100vh - 5rem)' }}>
      {/* Minimal top bar */}
      <div className="flex items-center justify-between gap-4 border-b border-th-border px-2 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/"
            className="text-sm text-th-text-3 transition-colors hover:text-th-text-1"
          >
            &larr; Back
          </Link>
          <span className="text-th-border">|</span>
          <span className="truncate text-sm font-semibold text-th-text-1">{data.issue_identifier}</span>
          {data.issue_title ? (
            <span className="hidden truncate text-sm text-th-text-3 sm:inline">{data.issue_title}</span>
          ) : null}
          <Badge tone={issue?.status === 'retrying' ? 'retrying' : 'running'}>
            {titleCase(data.status)}
          </Badge>
          <span className="text-xs tabular-nums text-th-text-4">{runtimeForTimeline(data.sessions, now)}</span>
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
            className="shrink-0 text-xs"
          >
            Scroll to latest
          </Button>
        ) : null}
      </div>

      {/* Chat message stream */}
      <div
        className="flex-1 overflow-y-auto px-4 py-6"
        onScroll={(event) => {
          const element = event.currentTarget
          const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
          setFollowTail(distanceFromBottom < 96)
        }}
        ref={scrollRef}
      >
        <div className="mx-auto max-w-3xl space-y-1">
          {data.sessions.length === 0 ? (
            <div className="px-6 py-20 text-center text-sm text-th-text-3">
              No messages yet.
            </div>
          ) : null}

          {data.sessions.map((session) => (
            <SessionBlock key={`${session.session_id}-${session.live ? 'live' : session.id ?? 'history'}`} now={now} session={session} />
          ))}
        </div>
      </div>
    </div>
  )
}

function SessionBlock({ now, session }: { now: number; session: TimelineSession }) {
  const groupedEntries = groupConsecutiveByType(session.messages, 'tool_call') as SessionEntry[]

  return (
    <div>
      {/* Session divider */}
      <div className="chat-divider my-5">
        {session.live ? 'Live' : 'Session'} {session.session_id} · {formatDateTime(session.started_at)}
        {session.live ? ` · ${runtimeSince(session.started_at, now)}` : ''}
      </div>

      <div className="space-y-1">
        {groupedEntries.length === 0 ? (
          <div className="py-6 text-center text-sm text-th-text-4">
            No captured messages.
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
    </div>
  )
}

function TimelineEntryCard({ message }: { message: TimelineMessage }) {
  if (message.type === 'thinking') {
    return (
      <details className="chat-message group py-1">
        <summary className="cursor-pointer list-none text-sm text-th-text-4 hover:text-th-text-3 transition-colors">
          <span className="inline-block transition-transform group-open:rotate-90 mr-1">&rsaquo;</span>
          Thinking&hellip;
          <span className="ml-2 text-xs">{formatClock(message.timestamp) || ''}</span>
        </summary>
        <div className="mt-2 ml-4 whitespace-pre-wrap font-mono text-sm leading-6 text-th-text-3">
          {message.content}
        </div>
      </details>
    )
  }

  if (message.type === 'reasoning_summary') {
    return (
      <div className="chat-message border-l-4 border-th-accent/40 pl-4 py-3">
        <div className="text-xs font-medium text-th-accent mb-1">Reasoning summary</div>
        <div className="whitespace-pre-wrap text-sm leading-6 text-th-text-2">{message.content}</div>
      </div>
    )
  }

  if (message.type === 'turn_boundary') {
    return (
      <div className="chat-divider my-4">
        {message.content}
      </div>
    )
  }

  if (message.type === 'error') {
    return (
      <div className="chat-message border-l-4 border-red-500/40 pl-4 py-3">
        <div className="text-xs font-medium text-red-500 mb-1">Error</div>
        <div className="whitespace-pre-wrap text-sm leading-6 text-th-text-2">{message.content}</div>
      </div>
    )
  }

  // Default: response and other message types — clean flowing text
  return (
    <div className="chat-message py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="h-1.5 w-1.5 rounded-full bg-th-accent/60 shrink-0" />
        <span className="text-xs text-th-text-4">{messageLabel(message.type)} · {formatClock(message.timestamp) || 'live'}</span>
      </div>
      <div className="whitespace-pre-wrap text-sm leading-7 text-th-text-2 pl-3.5">
        {message.content}
      </div>
    </div>
  )
}

function ToolGroup({ items }: { items: TimelineMessage[] }) {
  return (
    <details className="chat-message group py-1">
      <summary className="cursor-pointer list-none text-sm text-th-text-4 hover:text-th-text-3 transition-colors">
        <span className="inline-block transition-transform group-open:rotate-90 mr-1">&rsaquo;</span>
        Used {items.length} tool{items.length !== 1 ? 's' : ''}
        <span className="ml-2 text-xs">{formatClock(items.at(-1)?.timestamp) || ''}</span>
      </summary>

      <div className="mt-2 ml-4 space-y-1.5">
        {items.map((item) => {
          const metadata = item.metadata as Record<string, unknown>

          return (
            <div key={String(item.id)} className="rounded-md bg-th-muted/50 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-th-text-2">{item.content}</span>
                <Badge tone={toolTone(metadata.status)}>{String(metadata.status ?? 'unknown')}</Badge>
              </div>
              <div className="mt-1 whitespace-pre-wrap font-mono text-xs leading-5 text-th-text-4">
                {formatJson(metadata)}
              </div>
            </div>
          )
        })}
      </div>
    </details>
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
        <h2 className="text-lg font-semibold tracking-tight text-th-text-1">Session history</h2>
        <p className="mt-1 text-sm text-th-text-3">
          Review past runs and jump directly into the retained timeline for a given issue.
        </p>
      </div>

      <div className="space-y-px overflow-hidden rounded-xl border border-th-border">
        {payload.sessions.length === 0 ? (
          <div className="bg-th-surface px-6 py-10 text-center text-sm text-th-text-3">
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
    <div className="flex items-center justify-between gap-4 border-b border-th-border bg-th-surface px-5 py-4 last:border-b-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {issueIdentifier ? (
            <Link
              className="text-sm font-semibold text-th-text-1 transition-colors hover:text-th-accent"
              params={{ issueIdentifier }}
              to="/session/$issueIdentifier"
            >
              {issueIdentifier}
            </Link>
          ) : (
            <span className="text-sm font-semibold text-th-text-1">Unknown issue</span>
          )}
          <Badge tone={session.status === 'failed' ? 'danger' : 'neutral'}>{titleCase(session.status)}</Badge>
        </div>
        <p className="mt-1 truncate text-sm text-th-text-3">{session.issue_title ?? 'No title stored'}</p>
        <p className="mt-0.5 text-xs text-th-text-4">
          {formatDateTime(session.started_at)} · {session.worker_host ?? 'local'} · {formatNumber(session.total_tokens)} tokens
        </p>
      </div>

      {issueIdentifier ? (
        <Link
          className="shrink-0 rounded-lg border border-th-border-muted px-3.5 py-2 text-sm font-medium text-th-text-2 transition-colors hover:border-th-text-3 hover:text-th-text-1"
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
          <h2 className="text-lg font-semibold tracking-tight text-th-text-1">Projects</h2>
          <p className="mt-1 text-sm text-th-text-3">
            Map Linear projects to GitHub repos and per-project workspace defaults.
          </p>
        </div>

        {feedback ? (
          <div className="rounded-lg border border-th-border-muted bg-th-muted px-4 py-3 text-sm text-th-text-2">
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
                className="w-full rounded-lg border border-th-border bg-th-inset px-3.5 py-2.5 text-sm text-th-text-1 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30"
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
          <h3 className="text-base font-semibold tracking-tight text-th-text-1">Current mappings</h3>
          <p className="mt-1 text-sm text-th-text-3">Each project card represents one stored mapping.</p>
        </div>

        {projectsQuery.isPending ? <LoadingPanel title="Loading projects" compact /> : null}
        {projectsQuery.isError ? (
          <ErrorPanel detail={formatQueryError(projectsQuery.error)} title="Projects unavailable" />
        ) : null}

        <div className="space-y-2">
          {projectsQuery.data?.projects.map((project: Project) => (
            <div
              className="rounded-lg border border-th-border bg-th-inset p-4"
              key={project.id}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-th-text-1">{project.name}</div>
                  <div className="mt-1 text-xs text-th-text-3">
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
              <div className="mt-3 font-mono text-xs leading-5 text-th-text-4">
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
        <h2 className="text-lg font-semibold tracking-tight text-th-text-1">Linear API Key</h2>
        <p className="mt-1 text-sm text-th-text-3">
          Required to connect Symphony to Linear. Get a personal API key from Linear Settings &rarr; Security &amp; access &rarr; Personal API keys.
        </p>
      </div>

      {feedback ? (
        <div className="rounded-lg border border-th-border-muted bg-th-muted px-4 py-3 text-sm text-th-text-2">
          {feedback}
        </div>
      ) : null}

      {existing ? (
        <div className="rounded-lg border border-th-border bg-th-inset p-4">
          <div className="flex items-center justify-between gap-3">
            <code className="text-sm text-th-text-2 break-all">
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
          <h2 className="text-lg font-semibold tracking-tight text-th-text-1">Settings</h2>
          <p className="mt-1 text-sm text-th-text-3">
            Manage global key-value settings used to build the workflow config overlay.
          </p>
        </div>

        {feedback ? (
          <div className="rounded-lg border border-th-border-muted bg-th-muted px-4 py-3 text-sm text-th-text-2">
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
          <h3 className="text-base font-semibold tracking-tight text-th-text-1">Stored settings</h3>
          <p className="mt-1 text-sm text-th-text-3">
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
              className="rounded-lg border border-th-border bg-th-inset p-4"
              key={setting.key}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-th-text-1">{setting.key}</div>
                  <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-th-text-3">
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
      <p className="text-xs font-medium uppercase tracking-[0.1em] text-th-text-3">Not found</p>
      <h2 className="mt-2 text-lg font-semibold tracking-tight text-th-text-1">
        The requested dashboard route does not exist.
      </h2>
      <p className="mt-2 text-sm text-th-text-3">
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
    <div className="rounded-xl border border-th-border bg-th-surface p-5">
      <div className="text-xs font-medium uppercase tracking-[0.08em] text-th-text-3">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-th-text-1">{value}</div>
      <div className="mt-1 text-sm text-th-text-4">{helper}</div>
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
    <div className="rounded-lg border border-th-border bg-th-surface px-3.5 py-2.5">
      <dt className="text-xs font-medium text-th-text-3">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-th-text-1">{value}</dd>
      {helper ? <div className="mt-0.5 text-xs text-th-text-4">{helper}</div> : null}
    </div>
  )
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="grid gap-1.5 text-sm font-medium text-th-text-2">
      <span>{label}</span>
      {children}
    </label>
  )
}

function LoadingPanel({ compact = false, title }: { compact?: boolean; title: string }) {
  return (
    <Card className={cn('text-center', compact && 'p-4')}>
      <p className="text-sm font-medium text-th-text-2">{title}</p>
      <p className="mt-1 text-sm text-th-text-4">Fetching the latest payload from Phoenix.</p>
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
