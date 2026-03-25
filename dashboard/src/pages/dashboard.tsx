import { useMemo } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  getState,
  getSessions,
  type StatePayload,
  type SessionsPayload,
  type LoadedWorkflow,
} from '../lib/api'
import { useDashboardStream } from '../lib/streams'
import {
  formatDateTime,
  formatNumber,
  formatRuntimeFromSeconds,
  runtimeSince,
} from '../lib/utils'
import { cn } from '../lib/utils'
import { useNow } from '../hooks/use-now'
import { formatQueryError } from '../lib/helpers'
import {
  Badge,
  EmptyState,
  ErrorPanel,
  LoadingPanel,
} from '../components/ui'

type RunningEntry = StatePayload['running'][number]
type RetryEntry = StatePayload['retrying'][number]
type DashboardProjectSection = {
  key: string
  title: string
  description: string
  running: RunningEntry[]
  retrying: RetryEntry[]
}

export function DashboardView() {
  const queryClient = useQueryClient()
  const now = useNow()

  const stateQuery = useQuery({
    queryKey: ['state'],
    queryFn: getState,
    refetchInterval: 10_000,
  })

  useDashboardStream(
    () => {
      void queryClient.invalidateQueries({ queryKey: ['state'] })
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'recent'] })
    },
    true,
  )

  const recentSessionsQuery = useQuery({
    queryKey: ['sessions', 'recent'],
    queryFn: () => getSessions({ limit: 50 }),
    refetchInterval: 10_000,
  })

  const recentSessions = useMemo(() => {
    if (!recentSessionsQuery.data) return []
    const cutoff = now - 24 * 60 * 60 * 1000
    return recentSessionsQuery.data.sessions.filter((session) => {
      if (!session.ended_at) return false
      const ts = session.ended_at ?? session.started_at
      return ts && new Date(ts).getTime() >= cutoff
    })
  }, [recentSessionsQuery.data, now])

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
      <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-th-text-1">
            Active sessions
          </h1>
          <p className="mt-1.5 text-sm text-th-text-3">
            {totalActive === 0
              ? 'No sessions are running right now.'
              : `${totalActive} session${totalActive !== 1 ? 's' : ''} in progress`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-th-text-4">
          <span className="tabular-nums">{formatNumber(payload.engine_totals.total_tokens)} tokens</span>
          <span className="tabular-nums">{formatRuntimeFromSeconds(payload.engine_totals.seconds_running)}</span>
        </div>
      </div>

      {payload.loaded_workflows && payload.loaded_workflows.length > 0 ? (
        <LoadedWorkflowsSection workflows={payload.loaded_workflows} />
      ) : null}

      {payload.error ? (
        <ErrorPanel title="Snapshot warning" detail={`${payload.error.code}: ${payload.error.message}`} />
      ) : null}

      {!hasEntries ? (
        <EmptyState
          icon={
            <svg className="h-5 w-5 text-th-text-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path d="M12 6v6l4 2" strokeLinecap="round" />
              <circle cx="12" cy="12" r="10" />
            </svg>
          }
          title="No active sessions"
          description="Sessions will appear here when the orchestrator claims tickets."
        />
      ) : null}

      {hasEntries ? (
        <div className="space-y-6">
          {sections.map((section) => (
            <ProjectSessionSection key={section.key} now={now} section={section} />
          ))}
        </div>
      ) : null}

      <div className="space-y-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-th-text-1">
              Recent sessions
            </h2>
            <p className="mt-1 text-sm text-th-text-3">
              Completed in the last 24 hours.
            </p>
          </div>

          <Link
            className="text-sm font-medium text-th-accent transition-colors hover:text-th-text-1"
            to="/history"
          >
            View all history &rarr;
          </Link>
        </div>

        {recentSessionsQuery.isPending ? (
          <div className="py-8 text-center text-sm text-th-text-4">Loading recent sessions...</div>
        ) : recentSessions.length === 0 ? (
          <EmptyState
            icon={
              <svg className="h-5 w-5 text-th-text-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path d="M9 12h6M9 16h6M5 8h14M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z" strokeLinecap="round" />
              </svg>
            }
            title="No recent sessions"
            description="Sessions from the last 24 hours will appear here."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {recentSessions.map((session, index) => (
              <HistoryCard key={session.id} index={index} session={session} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function LoadedWorkflowsSection({ workflows }: { workflows: LoadedWorkflow[] }) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium text-th-text-3">Loaded workflows</h2>
      <div className="flex flex-wrap gap-2">
        {workflows.map((workflow) => (
          <span
            key={workflow.name}
            className="inline-flex items-center rounded-full border border-th-border bg-th-surface px-3 py-1 text-sm font-medium text-th-text-2"
          >
            {workflow.display_name}
          </span>
        ))}
      </div>
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
          <p className="mt-1 text-sm text-th-text-4">{section.description}</p>
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

function LinearIssueBadge({ identifier }: { identifier: string }) {
  return (
    <button
      className="inline-flex shrink-0 items-center gap-1 rounded bg-th-accent-muted px-1.5 py-0.5 text-[11px] font-medium text-th-accent transition-colors hover:opacity-80"
      onClick={(e) => {
        e.stopPropagation()
        window.open(`https://linear.app/issue/${identifier}`, '_blank', 'noopener,noreferrer')
      }}
      type="button"
    >
      <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Linear
    </button>
  )
}

function MetaBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block max-w-full truncate rounded bg-th-muted px-1.5 py-0.5 text-[11px] text-th-text-4">
      {children}
    </span>
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
      className="session-card group w-[280px] shrink-0 rounded-xl border border-th-border bg-th-surface p-5 transition-all duration-150 hover:border-th-border-muted hover:shadow-sm sm:w-[320px]"
      params={{ issueIdentifier: entry.issue_identifier }}
      style={{ animationDelay: `${index * 40}ms` }}
      to="/session/$issueIdentifier"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-th-success" />
            <span className="truncate text-sm font-medium text-th-text-1">{entry.issue_identifier}</span>
            <LinearIssueBadge identifier={entry.issue_identifier} />
          </div>
          <p className="mt-2 line-clamp-2 text-[13px] leading-5 text-th-text-3">
            {entry.last_message ?? entry.last_event ?? 'Waiting for events\u2026'}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {entry.workflow_name ? <MetaBadge>{entry.workflow_name}</MetaBadge> : null}
        {entry.project_name ? <MetaBadge>{entry.project_name}</MetaBadge> : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-th-text-4">
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
      className="session-card group w-[280px] shrink-0 rounded-xl border border-th-border bg-th-surface p-5 transition-all duration-150 hover:border-th-border-muted hover:shadow-sm sm:w-[320px]"
      params={{ issueIdentifier: entry.issue_identifier }}
      style={{ animationDelay: `${index * 40}ms` }}
      to="/session/$issueIdentifier"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-th-warning" />
            <span className="truncate text-sm font-medium text-th-text-1">{entry.issue_identifier}</span>
            <LinearIssueBadge identifier={entry.issue_identifier} />
            <Badge tone="retrying">Retry {entry.attempt}</Badge>
          </div>
          <p className="mt-2 line-clamp-2 text-[13px] leading-5 text-th-text-3">
            {entry.error ?? 'Retry pending'}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {entry.workflow_name ? <MetaBadge>{entry.workflow_name}</MetaBadge> : null}
        {entry.project_name ? <MetaBadge>{entry.project_name}</MetaBadge> : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-th-text-4">
        <span className="tabular-nums">{formatDateTime(entry.due_at)}</span>
        {entry.worker_host ? <span>{entry.worker_host}</span> : null}
      </div>
    </Link>
  )
}

const ERROR_CATEGORY_CONFIG: Record<string, { tone: 'danger' | 'retrying' | 'live' | 'neutral'; label: string; className?: string }> = {
  infra: { tone: 'danger', label: 'Infra' },
  agent: { tone: 'retrying', label: 'Agent' },
  config: { tone: 'neutral', label: 'Config', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  timeout: { tone: 'live', label: 'Timeout' },
  shutdown: { tone: 'neutral', label: 'Shutdown' },
}

export function ErrorCategoryBadge({ category }: { category: string | null }) {
  if (!category) return null
  const config = ERROR_CATEGORY_CONFIG[category]
  if (!config) return <Badge tone="neutral">{category}</Badge>
  return <Badge tone={config.tone} className={config.className}>{config.label}</Badge>
}

export function HistoryCard({ index, session }: { index: number; session: SessionsPayload['sessions'][number] }) {
  const issueIdentifier = session.issue_identifier
  const failed = session.status === 'failed'

  const content = (
    <div
      className="session-card rounded-xl border border-th-border bg-th-surface p-5 transition-all duration-150 hover:border-th-border-muted hover:shadow-sm"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', failed ? 'bg-th-danger' : 'bg-th-text-4')} />
            <span className="truncate text-sm font-medium text-th-text-1">
              {issueIdentifier ?? 'Unknown'}
            </span>
            {issueIdentifier ? <LinearIssueBadge identifier={issueIdentifier} /> : null}
            {failed ? <Badge tone="danger">Failed</Badge> : null}
            {failed ? <ErrorCategoryBadge category={session.error_category} /> : null}
          </div>
          <p className="mt-2 line-clamp-1 text-[13px] leading-5 text-th-text-3">
            {session.issue_title ?? 'No title'}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {session.workflow_name ? <MetaBadge>{session.workflow_name}</MetaBadge> : null}
        {session.github_repo ? <MetaBadge>{session.github_repo}</MetaBadge> : null}
        {session.github_branch ? <MetaBadge>{session.github_branch}</MetaBadge> : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-th-text-4">
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

function buildDashboardProjectSections(payload: StatePayload): DashboardProjectSection[] {
  const groupedSections = new Map<number, DashboardProjectSection>()

  for (const entry of payload.running) {
    if (entry.project_id === null) continue
    const current = groupedSections.get(entry.project_id) ?? {
      key: `project-${entry.project_id}`,
      title: entry.project_name || `Project ${entry.project_id}`,
      description: `Live sessions for ${entry.project_name || `project ${entry.project_id}`}.`,
      running: [],
      retrying: [],
    }
    current.running.push(entry)
    groupedSections.set(entry.project_id, current)
  }

  for (const entry of payload.retrying) {
    if (entry.project_id === null) continue
    const current = groupedSections.get(entry.project_id) ?? {
      key: `project-${entry.project_id}`,
      title: entry.project_name || `Project ${entry.project_id}`,
      description: `Live sessions for ${entry.project_name || `project ${entry.project_id}`}.`,
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
