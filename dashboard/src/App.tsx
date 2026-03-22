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
import * as Collapsible from '@radix-ui/react-collapsible'
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
  type StatePayload,
  type SessionsPayload,
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

type SessionEntry =
  | TimelineMessage
  | {
      type: 'tool_call_group'
      items: TimelineMessage[]
    }

type ProjectDraft = ReturnType<typeof emptyProject>
type RunningEntry = StatePayload['running'][number]
type RetryEntry = StatePayload['retrying'][number]
type DashboardProjectSection = {
  key: string
  title: string
  description: string
  running: RunningEntry[]
  retrying: RetryEntry[]
}

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
  const [mobileNavState, setMobileNavState] = useState({
    open: false,
    path: pathname,
  })
  const mobileNavOpen = mobileNavState.path === pathname && mobileNavState.open

  return (
    <div className="min-h-screen bg-th-bg text-th-text-2 transition-colors duration-200">
      <div className="mx-auto flex min-h-screen w-full max-w-[1120px] flex-col px-4 sm:px-6 lg:px-10">
        <Collapsible.Root
          className="border-b border-th-border"
          onOpenChange={(open) => {
            setMobileNavState({ open, path: pathname })
          }}
          open={mobileNavOpen}
        >
          <header className="flex min-h-14 items-center justify-between gap-3 py-3 md:py-0">
            <div className="flex min-w-0 items-center gap-3 sm:gap-8">
              <Link to="/" className="flex shrink-0 items-center gap-2.5">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-th-accent">
                  <svg className="h-3.5 w-3.5 text-white" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 1l2.5 5h5L11 9.5l1.5 5.5L8 12l-4.5 3 1.5-5.5L0.5 6h5z" />
                  </svg>
                </div>
                <span className="text-sm font-semibold text-th-text-1">Symphony</span>
              </Link>

              <nav className="hidden min-w-0 items-center gap-0.5 md:flex">
                <HeaderLink active={pathname === '/'} label="Dashboard" to="/" />
                <HeaderLink active={pathname.startsWith('/history')} label="History" to="/history" />
                <HeaderLink active={pathname.startsWith('/projects')} label="Projects" to="/projects" />
                <HeaderLink active={pathname.startsWith('/settings')} label="Settings" to="/settings" />
              </nav>
            </div>

            <div className="flex items-center gap-2">
              <Button
                aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
                className="text-th-text-4 hover:bg-th-muted hover:text-th-text-2"
                onClick={toggle}
                size="icon"
                type="button"
                variant="ghost"
              >
                {dark ? (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="5" />
                    <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                )}
              </Button>

              <Collapsible.Trigger asChild>
                <Button
                  aria-label={mobileNavOpen ? 'Close navigation menu' : 'Open navigation menu'}
                  className="md:hidden"
                  size="icon"
                  type="button"
                  variant="secondary"
                >
                  {mobileNavOpen ? (
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                      <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                      <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
                    </svg>
                  )}
                </Button>
              </Collapsible.Trigger>
            </div>
          </header>

          <Collapsible.Content className="border-t border-th-border/70 pb-3 md:hidden">
            <nav className="grid gap-1 pt-3">
              <HeaderLink active={pathname === '/'} label="Dashboard" mobile onNavigate={() => setMobileNavState((current) => ({ ...current, open: false }))} to="/" />
              <HeaderLink active={pathname.startsWith('/history')} label="History" mobile onNavigate={() => setMobileNavState((current) => ({ ...current, open: false }))} to="/history" />
              <HeaderLink active={pathname.startsWith('/projects')} label="Projects" mobile onNavigate={() => setMobileNavState((current) => ({ ...current, open: false }))} to="/projects" />
              <HeaderLink active={pathname.startsWith('/settings')} label="Settings" mobile onNavigate={() => setMobileNavState((current) => ({ ...current, open: false }))} to="/settings" />
            </nav>
          </Collapsible.Content>
        </Collapsible.Root>

        <main className="flex-1 py-6 sm:py-10">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function HeaderLink({
  active,
  label,
  mobile = false,
  onNavigate,
  to,
}: {
  active: boolean
  label: string
  mobile?: boolean
  onNavigate?: () => void
  to: string
}) {
  return (
    <Link
      className={cn(
        'rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors duration-100',
        mobile && 'w-full px-3 py-2 text-left',
        active
          ? 'bg-th-muted text-th-text-1'
          : 'text-th-text-3 hover:text-th-text-1',
      )}
      onClick={onNavigate}
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
  const sections = buildDashboardProjectSections(payload)
  const totalActive = payload.counts.running + payload.counts.retrying
  const hasEntries = payload.running.length > 0 || payload.retrying.length > 0

  return (
    <div className="space-y-10">
      {/* Page heading with inline stats */}
      <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-th-text-1">
            Active sessions
          </h1>
          <p className="mt-1.5 text-[13px] text-th-text-3">
            {totalActive === 0
              ? 'No sessions are running right now.'
              : `${totalActive} session${totalActive !== 1 ? 's' : ''} in progress`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-th-text-4">
          <span className="tabular-nums">{formatNumber(payload.codex_totals.total_tokens)} tokens</span>
          <span className="tabular-nums">{formatRuntimeFromSeconds(payload.codex_totals.seconds_running)}</span>
        </div>
      </div>

      {payload.error ? (
        <ErrorPanel title="Snapshot warning" detail={`${payload.error.code}: ${payload.error.message}`} />
      ) : null}

      {/* Empty state */}
      {!hasEntries ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-th-muted">
            <svg className="h-5 w-5 text-th-text-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path d="M12 6v6l4 2" strokeLinecap="round" />
              <circle cx="12" cy="12" r="10" />
            </svg>
          </div>
          <p className="mt-4 text-sm font-medium text-th-text-2">No active sessions</p>
          <p className="mt-1 text-[13px] text-th-text-4">
            Sessions will appear here when the orchestrator claims tickets.
          </p>
        </div>
      ) : null}

      {/* Session cards */}
      {hasEntries ? (
        <div className="space-y-6">
          {sections.map((section) => (
            <ProjectSessionSection key={section.key} now={now} section={section} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ProjectSessionSection({
  now,
  section,
}: {
  now: number
  section: DashboardProjectSection
}) {
  const totalEntries = section.running.length + section.retrying.length

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-th-text-1">{section.title}</h2>
          <p className="mt-1 text-[13px] text-th-text-4">{section.description}</p>
        </div>

        <span className="rounded-full bg-th-muted px-2.5 py-1 text-xs font-medium text-th-text-3">
          {totalEntries} active
        </span>
      </div>

      {totalEntries === 0 ? (
        <div className="rounded-xl border border-dashed border-th-border bg-th-surface/60 px-4 py-5 text-sm text-th-text-4">
          No live agents in this project right now.
        </div>
      ) : (
        <div className="-mx-1 overflow-x-auto pb-2">
          <div className="flex min-w-full gap-3 px-1">
            {section.running.map((entry, index) => (
              <RunningSessionCard key={`running-${entry.issue_id}`} entry={entry} index={index} now={now} />
            ))}

            {section.retrying.map((entry, index) => (
              <RetrySessionCard
                key={`retry-${entry.issue_id}`}
                entry={entry}
                index={section.running.length + index}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function RunningSessionCard({
  entry,
  index,
  now,
}: {
  entry: RunningEntry
  index: number
  now: number
}) {
  return (
    <Link
      className="session-card group w-[280px] shrink-0 rounded-lg border border-th-border bg-th-surface p-5 transition-colors duration-100 hover:border-th-border-muted sm:w-[320px]"
      params={{ issueIdentifier: entry.issue_identifier }}
      style={{ animationDelay: `${index * 40}ms` }}
      to="/session/$issueIdentifier"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
            <span className="truncate text-sm font-medium text-th-text-1">{entry.issue_identifier}</span>
          </div>
          <p className="mt-2 line-clamp-2 text-[13px] leading-5 text-th-text-3">
            {entry.last_message ?? entry.last_event ?? 'Waiting for events\u2026'}
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-th-text-4">
        <span className="tabular-nums">{runtimeSince(entry.started_at, now)}</span>
        <span className="tabular-nums">{formatNumber(entry.turn_count)} turns</span>
        <span className="tabular-nums">{formatNumber(entry.tokens.total_tokens)} tok</span>
        {entry.worker_host ? <span>{entry.worker_host}</span> : null}
      </div>
    </Link>
  )
}

function RetrySessionCard({
  entry,
  index,
}: {
  entry: RetryEntry
  index: number
}) {
  return (
    <Link
      className="session-card group w-[280px] shrink-0 rounded-lg border border-th-border bg-th-surface p-5 transition-colors duration-100 hover:border-th-border-muted sm:w-[320px]"
      params={{ issueIdentifier: entry.issue_identifier }}
      style={{ animationDelay: `${index * 40}ms` }}
      to="/session/$issueIdentifier"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
            <span className="truncate text-sm font-medium text-th-text-1">{entry.issue_identifier}</span>
            <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              Retry {entry.attempt}
            </span>
          </div>
          <p className="mt-2 line-clamp-2 text-[13px] leading-5 text-th-text-3">
            {entry.error ?? 'Retry pending'}
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-th-text-4">
        <span className="tabular-nums">{formatDateTime(entry.due_at)}</span>
        {entry.worker_host ? <span>{entry.worker_host}</span> : null}
      </div>
    </Link>
  )
}

function buildDashboardProjectSections(
  payload: StatePayload,
): DashboardProjectSection[] {
  const groupedSections = new Map<number, DashboardProjectSection>()

  for (const entry of payload.running) {
    if (entry.project_id === null) {
      continue
    }

    const current =
      groupedSections.get(entry.project_id) ??
        {
          key: `project-${entry.project_id}`,
          title: dashboardProjectTitle(entry.project_id, entry.project_name),
          description: dashboardProjectSectionDescription(entry.project_id, entry.project_name),
          running: [],
          retrying: [],
        }

    current.running.push(entry)
    groupedSections.set(entry.project_id, current)
  }

  for (const entry of payload.retrying) {
    if (entry.project_id === null) {
      continue
    }

    const current =
      groupedSections.get(entry.project_id) ??
        {
          key: `project-${entry.project_id}`,
          title: dashboardProjectTitle(entry.project_id, entry.project_name),
          description: dashboardProjectSectionDescription(entry.project_id, entry.project_name),
          running: [],
          retrying: [],
        }

    current.retrying.push(entry)
    groupedSections.set(entry.project_id, current)
  }

  const sections = Array.from(groupedSections.values())
  const runningWithoutProject = payload.running.filter((entry) => entry.project_id === null)
  const retryingWithoutProject = payload.retrying.filter((entry) => entry.project_id === null)

  if (runningWithoutProject.length > 0 || retryingWithoutProject.length > 0) {
    sections.push({
      key: 'project-unassigned',
      title: 'Unassigned',
      description: 'Live entries without a project mapping.',
      running: runningWithoutProject,
      retrying: retryingWithoutProject,
    })
  }

  return sections
}

function dashboardProjectTitle(projectId: number, projectName: string | null) {
  if (projectName) {
    return projectName
  }

  return `Project ${projectId}`
}

function dashboardProjectSectionDescription(projectId: number, projectName: string | null) {
  if (projectName) {
    return `Live sessions for ${projectName}.`
  }

  return `Live sessions for project ${projectId}.`
}

function SessionView() {
  const { issueIdentifier } = sessionRoute.useParams()
  const now = useNow()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [followTail, setFollowTail] = useState(true)
  const [timeline, setTimeline] = useState<MessagesPayload | null>(null)
  const syncFollowTail = useCallback(() => {
    const element = scrollRef.current

    if (!element) {
      return
    }

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    setFollowTail(distanceFromBottom < 96)
  }, [])

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
  const currentFollowTail = followTail
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
    const element = scrollRef.current

    if (!element) {
      return
    }

    syncFollowTail()
    element.addEventListener('scroll', syncFollowTail, { passive: true })

    return () => {
      element.removeEventListener('scroll', syncFollowTail)
    }
  }, [currentTimeline, syncFollowTail])

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
    <div className="relative flex h-[calc(100dvh-7.5rem)] min-h-[32rem] flex-col overflow-hidden rounded-2xl border border-th-border bg-th-surface">
      <div className="flex flex-col gap-3 border-b border-th-border px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link
            to="/"
            className="flex items-center gap-1 text-[13px] text-th-text-4 transition-colors hover:text-th-text-1"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back
          </Link>
          <span className="hidden h-3.5 w-px bg-th-border sm:block" />
          <Badge tone={issue?.status === 'retrying' ? 'retrying' : 'live'}>
            {issue?.status === 'retrying' ? 'Retrying' : 'Live'}
          </Badge>
          <span className="text-xs tabular-nums text-th-text-4">{runtimeForTimeline(data.sessions, now)}</span>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-th-text-1">{data.issue_identifier}</span>
            {data.issue_title ? (
              <span className="min-w-0 break-words text-[13px] text-th-text-3 sm:truncate">{data.issue_title}</span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Chat message stream */}
      <div
        className="flex-1 overflow-y-auto px-3 pb-24 pt-5 sm:px-4 sm:py-6"
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

      {!currentFollowTail ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-20 flex justify-center px-4 sm:bottom-6">
          <Button
            className="pointer-events-auto rounded-full border-th-border bg-th-surface/95 px-4 shadow-lg shadow-black/10 backdrop-blur dark:shadow-black/30"
            onClick={() => {
              setFollowTail(true)
              const element = scrollRef.current

              if (element) {
                element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
              }
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path d="M12 5v14M6 13l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Scroll to latest
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function SessionBlock({ now, session }: { now: number; session: TimelineSession }) {
  const groupedEntries = groupConsecutiveByType(session.messages, 'tool_call') as SessionEntry[]

  return (
    <div>
      {/* Session divider */}
      <div className="chat-divider my-5 text-[11px] sm:text-xs">
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
        <div className="mt-2 ml-4 whitespace-pre-wrap break-words font-mono text-sm leading-6 text-th-text-3">
          {message.content}
        </div>
      </details>
    )
  }

  if (message.type === 'reasoning_summary') {
    return (
      <div className="chat-message border-l-4 border-th-accent/40 pl-4 py-3">
        <div className="text-xs font-medium text-th-accent mb-1">Reasoning summary</div>
        <div className="whitespace-pre-wrap break-words text-sm leading-6 text-th-text-2">{message.content}</div>
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
        <div className="whitespace-pre-wrap break-words text-sm leading-6 text-th-text-2">{message.content}</div>
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
      <div className="whitespace-pre-wrap break-words pl-3.5 text-sm leading-7 text-th-text-2">
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
                <span className="break-words text-sm text-th-text-2">{item.content}</span>
                <Badge tone={toolTone(metadata.status)}>{String(metadata.status ?? 'unknown')}</Badge>
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-th-text-4">
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
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
  })
  const sessionsQuery = useQuery({
    queryKey: ['sessions', 'history', selectedProjectId],
    queryFn: () => getSessions({ limit: 100, projectId: selectedProjectId ?? undefined }),
  })

  if (sessionsQuery.isPending) {
    return <LoadingPanel title="Loading session history" />
  }

  if (sessionsQuery.isError) {
    return <ErrorPanel title="History unavailable" detail={formatQueryError(sessionsQuery.error)} />
  }

  const payload = sessionsQuery.data
  const projects = projectsQuery.data?.projects ?? []
  const selectedProject = projects.find((project) => project.id === selectedProjectId)

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-th-text-1">History</h1>
        <p className="mt-1.5 text-[13px] text-th-text-3">
          Past sessions and their timelines.
        </p>
      </div>

      <Card className="space-y-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold tracking-tight text-th-text-1">Filter history</h2>
            <p className="text-[13px] text-th-text-3">
              Narrow completed sessions to a single configured project.
            </p>
          </div>

          <div className="w-full md:max-w-xs">
            <Field label="Project">
              <select
                className="w-full rounded-lg border border-th-border bg-th-inset px-3.5 py-2.5 text-sm text-th-text-1 outline-none transition focus:border-th-accent focus:ring-1 focus:ring-th-accent/30"
                onChange={(event) => {
                  const value = event.target.value
                  setSelectedProjectId(value === '' ? null : Number(value))
                }}
                value={selectedProjectId ?? ''}
              >
                <option value="">All projects</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>

        {projectsQuery.isPending ? (
          <p className="text-xs text-th-text-4">Loading available projects…</p>
        ) : null}

        {projectsQuery.isError ? (
          <p className="text-xs text-th-text-4">
            Project list unavailable. Showing all history until project data loads again.
          </p>
        ) : null}
      </Card>

      {payload.sessions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-th-muted">
            <svg className="h-5 w-5 text-th-text-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path d="M9 12h6M9 16h6M5 8h14M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z" strokeLinecap="round" />
            </svg>
          </div>
          <p className="mt-4 text-sm font-medium text-th-text-2">
            {selectedProject ? `No sessions for ${selectedProject.name} yet` : 'No sessions yet'}
          </p>
          <p className="mt-1 text-[13px] text-th-text-4">
            {selectedProject ? 'Try another project or switch back to all history.' : 'Completed sessions will appear here.'}
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {payload.sessions.map((session, index) => (
          <HistoryCard key={session.id} index={index} session={session} />
        ))}
      </div>
    </div>
  )
}

function HistoryCard({ index, session }: { index: number; session: SessionsPayload['sessions'][number] }) {
  const issueIdentifier = session.issue_identifier
  const failed = session.status === 'failed'

  const content = (
    <div
      className="session-card rounded-lg border border-th-border bg-th-surface p-5 transition-colors duration-100 hover:border-th-border-muted"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', failed ? 'bg-red-500' : 'bg-th-text-4')} />
            <span className="truncate text-sm font-medium text-th-text-1">
              {issueIdentifier ?? 'Unknown'}
            </span>
            {failed ? (
              <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-500">
                Failed
              </span>
            ) : null}
          </div>
          <p className="mt-2 line-clamp-1 text-[13px] leading-5 text-th-text-3">
            {session.issue_title ?? 'No title'}
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-th-text-4">
        <span className="tabular-nums">{formatDateTime(session.started_at)}</span>
        <span className="tabular-nums">{formatNumber(session.total_tokens)} tok</span>
        {session.worker_host ? <span>{session.worker_host}</span> : null}
      </div>
    </div>
  )

  if (!issueIdentifier) {
    return content
  }

  return (
    <Link params={{ issueIdentifier }} to="/session/$issueIdentifier">
      {content}
    </Link>
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
      <Card className="min-w-0 space-y-5">
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

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button className="w-full sm:w-auto" disabled={saveMutation.isPending} type="submit">
              {editingId === null ? 'Create project' : 'Save changes'}
            </Button>
            {editingId !== null ? (
              <Button
                className="w-full sm:w-auto"
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

      <Card className="min-w-0 space-y-4">
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
              className="overflow-hidden rounded-lg border border-th-border bg-th-inset p-4"
              key={project.id}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-th-text-1">{project.name}</div>
                  <div className="mt-1 break-all text-xs text-th-text-3">
                    {project.github_repo ?? 'No repo configured'}
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    className="w-full sm:w-auto"
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
                    className="w-full sm:w-auto"
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
              <div className="mt-3 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-th-text-4">
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
    <Card className="min-w-0 space-y-4">
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
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <code className="min-w-0 break-all text-sm text-th-text-2">
              {showKey ? existing.value : maskedValue}
            </code>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <Button className="w-full sm:w-auto" onClick={() => setShowKey(!showKey)} type="button" variant="secondary">
                {showKey ? 'Hide' : 'Reveal'}
              </Button>
              <Button
                className="w-full sm:w-auto"
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
          <Button className="w-full sm:w-auto" disabled={saveMutation.isPending || !apiKey.trim()} type="submit">
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
      <Card className="min-w-0 space-y-5">
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

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button className="w-full sm:w-auto" disabled={saveMutation.isPending} type="submit">
              {editingKey === null ? 'Save setting' : 'Update setting'}
            </Button>
            {editingKey !== null ? (
              <Button
                className="w-full sm:w-auto"
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

      <Card className="min-w-0 space-y-4">
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
              className="overflow-hidden rounded-lg border border-th-border bg-th-inset p-4"
              key={setting.key}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-th-text-1">{setting.key}</div>
                  <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-th-text-3">
                    {setting.value}
                  </pre>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    className="w-full sm:w-auto"
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
                    className="w-full sm:w-auto"
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
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="text-5xl font-semibold text-th-text-4">404</p>
      <p className="mt-3 text-sm font-medium text-th-text-2">Page not found</p>
      <p className="mt-1 text-[13px] text-th-text-4">
        This route doesn&apos;t exist.
      </p>
      <Link to="/" className="mt-6 text-[13px] font-medium text-th-accent hover:underline">
        Back to dashboard
      </Link>
    </div>
  )
}


function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="grid min-w-0 gap-1.5 text-sm font-medium text-th-text-2">
      <span>{label}</span>
      {children}
    </label>
  )
}

function LoadingPanel({ compact = false, title }: { compact?: boolean; title: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'py-6' : 'py-24')}>
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-th-border border-t-th-accent" />
      <p className="mt-4 text-sm font-medium text-th-text-2">{title}</p>
    </div>
  )
}

function ErrorPanel({ detail, title }: { detail: string; title: string }) {
  return (
    <div className="rounded-lg border border-red-500/15 bg-red-500/5 px-5 py-4">
      <p className="text-sm font-medium text-red-500 dark:text-red-400">{title}</p>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-5 text-red-500/70 dark:text-red-400/60">{detail}</p>
    </div>
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
