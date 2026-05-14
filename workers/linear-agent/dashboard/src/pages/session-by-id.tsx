import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { getSessionDebug, type SessionDebugMessage, type WorkerSessionDebug } from '../lib/api'
import { formatClock } from '../lib/utils'
import { formatQueryError, titleCase } from '../lib/helpers'
import { Badge } from '../components/ui'
import { ErrorPanel, LoadingPanel } from '../components/feedback'

import { sessionByIdRoute } from '../router'

export function SessionByIdView() {
  const { sessionId } = sessionByIdRoute.useParams()

  const sessionQuery = useQuery({
    queryKey: ['session-debug', sessionId],
    queryFn: () => getSessionDebug(sessionId),
    refetchInterval: (query) =>
      query.state.data?.status === 'running' ? 5_000 : false,
  })

  if (sessionQuery.isPending) {
    return <LoadingPanel title="Loading session" />
  }

  if (sessionQuery.isError) {
    return <ErrorPanel title="Session unavailable" detail={formatQueryError(sessionQuery.error)} />
  }

  const session = sessionQuery.data
  if (!session) {
    return <ErrorPanel title="Session unavailable" detail="The session payload did not load." />
  }

  const status = session.status ?? 'unknown'
  const isRunning = status === 'running'
  const messages = session.messages ?? []

  return (
    <div className="relative flex h-[calc(100dvh-7.5rem)] min-h-[32rem] flex-col overflow-hidden rounded-2xl border border-th-border bg-th-surface">
      <div className="flex flex-col gap-3 border-b border-th-border px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link
            to="/history"
            className="flex items-center gap-1 text-sm text-th-text-4 transition-colors hover:text-th-text-1"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back
          </Link>
          <span className="hidden h-3.5 w-px bg-th-border sm:block" />
          <Badge variant={isRunning ? 'live' : status === 'error' ? 'destructive' : 'secondary'}>
            {titleCase(status)}
          </Badge>
        </div>

        <div className="min-w-0 space-y-1">
          {session.linear_issue_title ? (
            <div className="break-words text-sm font-semibold text-th-text-1">
              {session.linear_issue_title}
            </div>
          ) : null}
          <div className="text-xs text-th-text-4">
            Session {session.id}
            {session.triggered_by ? <> · triggered by {session.triggered_by}</> : null}
            {session.started_at ? <> · started {formatEpoch(session.started_at)}</> : null}
            {session.completed_at ? <> · ended {formatEpoch(session.completed_at)}</> : null}
          </div>
        </div>

        {session.error ? (
          <div className="rounded-md border border-th-danger/40 bg-th-danger/5 px-3 py-2 text-xs text-th-danger">
            {session.error}
          </div>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-8 pt-5 sm:px-5 sm:py-6">
        <div className="mx-auto max-w-3xl space-y-1">
          {messages.length === 0 ? (
            <div className="px-6 py-20 text-center text-sm text-th-text-3">
              {isRunning ? 'Waiting for first event…' : 'No captured messages.'}
            </div>
          ) : (
            messages.map((m, i) => <SessionEventCard key={i} entry={m} />)
          )}

          {session.stderr ? (
            <details className="mt-6 rounded-md border border-th-border bg-th-muted/30 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-th-text-3">
                stderr
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-th-text-3">
                {session.stderr}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function SessionEventCard({ entry }: { entry: SessionDebugMessage }) {
  const { type, content, timestamp } = normalizeEntry(entry)

  if (type === 'thought' || type === 'thinking') {
    return (
      <details className="chat-message group py-1">
        <summary className="cursor-pointer list-none text-sm text-th-text-4 hover:text-th-text-3 transition-colors">
          <span className="inline-block transition-transform group-open:rotate-90 mr-1">&rsaquo;</span>
          Thinking
          <span className="ml-2 text-xs">{formatClock(timestamp) || ''}</span>
        </summary>
        <div className="mt-2 ml-4 whitespace-pre-wrap break-words font-mono text-sm leading-6 text-th-text-3">
          {content}
        </div>
      </details>
    )
  }

  if (type === 'error') {
    return (
      <div className="chat-message border-l-4 border-th-danger/40 pl-4 py-3">
        <div className="text-xs font-medium text-th-danger mb-1">Error</div>
        <div className="whitespace-pre-wrap break-words text-sm leading-6 text-th-text-2">{content}</div>
      </div>
    )
  }

  return (
    <div className="chat-message py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="h-1.5 w-1.5 rounded-full bg-th-accent/60 shrink-0" />
        <span className="text-xs text-th-text-4">
          {titleCase(type)} · {formatClock(timestamp) || 'live'}
        </span>
      </div>
      <div className="whitespace-pre-wrap break-words pl-3.5 text-sm leading-7 text-th-text-2">
        {content}
      </div>
    </div>
  )
}

function normalizeEntry(entry: SessionDebugMessage): {
  type: string
  content: string
  timestamp: string | null
} {
  if (typeof entry === 'string') {
    return { type: 'message', content: entry, timestamp: null }
  }
  const modern = entry as { type?: string; body?: string | null; timestamp?: string }
  const legacy = entry as { role?: string; content?: string; timestamp?: string }
  return {
    type: modern.type ?? legacy.role ?? 'message',
    content: modern.body ?? legacy.content ?? '',
    timestamp: modern.timestamp ?? legacy.timestamp ?? null,
  }
}

function formatEpoch(value: WorkerSessionDebug['started_at']): string {
  if (value === null || value === undefined) return ''
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return String(value)
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms))
}
