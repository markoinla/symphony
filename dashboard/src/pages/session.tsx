import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import {
  getIssue,
  getSessionTimeline,
  mergeTimelineMessage,
  updateTimelineMessage,
  type MessagesPayload,
  type TimelineMessage,
  type TimelineSession,
} from '../lib/api'
import { useSessionStream } from '../lib/streams'
import {
  estimateCost,
  formatClock,
  formatCost,
  formatDateTime,
  formatNumber,
  formatRuntimeFromSeconds,
  groupConsecutiveByType,
  runtimeSince,
  sumSessionRuntimeSeconds,
} from '../lib/utils'
import { useNow } from '../hooks/use-now'
import { formatQueryError, formatJson, titleCase } from '../lib/helpers'
import { Badge, Button, ErrorPanel, LoadingPanel } from '../components/ui'

import { sessionRoute } from '../router'

type SessionEntry =
  | TimelineMessage
  | {
      type: 'tool_call_group'
      items: TimelineMessage[]
    }

export function SessionView() {
  const { issueIdentifier } = sessionRoute.useParams()
  const now = useNow()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [followTail, setFollowTail] = useState(true)
  const [timeline, setTimeline] = useState<MessagesPayload | null>(null)
  const syncFollowTail = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
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
    refetchInterval: (query) => {
      const sseHasLive = timeline?.sessions.some((s) => s.live) ?? false
      const fetchedHasLive = query.state.data?.sessions.some((s: TimelineSession) => s.live) ?? false
      return sseHasLive || fetchedHasLive ? 5_000 : false
    },
  })

  const currentTimeline = useMemo(() => {
    const local = timeline?.issue_identifier === issueIdentifier ? timeline : null
    const fetched = timelineQuery.data ?? null

    if (!local) return fetched
    if (!fetched) return local

    const sessions = local.sessions.map((localSession) => {
      const fresh = fetched.sessions.find((s) => s.session_id === localSession.session_id)
      if (!fresh) return localSession
      return {
        ...localSession,
        input_tokens: fresh.input_tokens,
        output_tokens: fresh.output_tokens,
        total_tokens: fresh.total_tokens,
        turn_count: fresh.turn_count,
        status: fresh.status,
        ended_at: fresh.ended_at,
        live: fresh.live,
      }
    })

    const localIds = new Set(local.sessions.map((s) => s.session_id))
    const newSessions = fetched.sessions.filter((s) => !localIds.has(s.session_id))

    return { ...local, sessions: [...sessions, ...newSessions] }
  }, [timeline, timelineQuery.data, issueIdentifier])
  const currentFollowTail = followTail
  const activeIssueId = issueQuery.data?.issue_id ?? currentTimeline?.issue_id

  useSessionStream(
    activeIssueId,
    (payload) => {
      setTimeline((current) => {
        const base = current?.issue_identifier === issueIdentifier ? current : timelineQuery.data ?? null
        return base ? mergeTimelineMessage(base, payload as TimelineMessage) : current
      })
    },
    (payload) => {
      setTimeline((current) => {
        const base = current?.issue_identifier === issueIdentifier ? current : timelineQuery.data ?? null
        return base ? updateTimelineMessage(base, payload as TimelineMessage) : current
      })
    },
  )

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    syncFollowTail()
    element.addEventListener('scroll', syncFollowTail, { passive: true })
    return () => element.removeEventListener('scroll', syncFollowTail)
  }, [currentTimeline, syncFollowTail])

  useEffect(() => {
    if (!currentFollowTail) return
    const element = scrollRef.current
    if (!element) return
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
      <div className="flex flex-col gap-3 border-b border-th-border px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link
            to="/"
            className="flex items-center gap-1 text-sm text-th-text-4 transition-colors hover:text-th-text-1"
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
            <LinearIssueBadge identifier={data.issue_identifier} />
            {data.issue_title ? (
              <span className="min-w-0 break-words text-sm text-th-text-3 sm:truncate">{data.issue_title}</span>
            ) : null}
          </div>
        </div>

        <SessionUsageBar now={now} sessions={data.sessions} />
      </div>

      <div
        className="flex-1 overflow-y-auto px-4 pb-24 pt-5 sm:px-5 sm:py-6"
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
              if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
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

function LinearIssueBadge({ identifier }: { identifier: string }) {
  return (
    <a
      className="inline-flex shrink-0 items-center gap-1 rounded bg-th-accent-muted px-1.5 py-0.5 text-[11px] font-medium text-th-accent transition-colors hover:opacity-80"
      href={`https://linear.app/issue/${identifier}`}
      onClick={(e) => e.stopPropagation()}
      rel="noopener noreferrer"
      target="_blank"
    >
      <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Linear
    </a>
  )
}

function SessionUsageBar({ now, sessions }: { now: number; sessions: TimelineSession[] }) {
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0

  for (const session of sessions) {
    inputTokens += session.input_tokens ?? 0
    outputTokens += session.output_tokens ?? 0
    totalTokens += session.total_tokens ?? 0
  }

  const runtimeSeconds = sumSessionRuntimeSeconds(sessions, now)
  const hasData = totalTokens > 0 || sessions.some((s) => s.started_at)
  if (!hasData) return null

  const cost = estimateCost(inputTokens, outputTokens)

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-th-text-4">
      {totalTokens > 0 ? (
        <>
          <span>{formatNumber(totalTokens)} tokens</span>
          <span>{formatNumber(inputTokens)} in</span>
          <span>{formatNumber(outputTokens)} out</span>
          <span>{formatCost(cost)}</span>
        </>
      ) : null}
      <span>{formatRuntimeFromSeconds(runtimeSeconds)}</span>
    </div>
  )
}

function SessionBlock({ now, session }: { now: number; session: TimelineSession }) {
  const groupedEntries = groupConsecutiveByType(session.messages, 'tool_call') as SessionEntry[]

  return (
    <div>
      <div className="chat-divider my-5 text-[11px] sm:text-xs">
        <span>
          {session.live ? 'Live' : 'Session'} {session.session_id} · {formatDateTime(session.started_at)}
          {session.live ? ` · ${runtimeSince(session.started_at, now)}` : ''}
        </span>
        {session.status === 'failed' && session.error_category ? (
          <Badge className="ml-2" tone={session.error_category === 'infra' ? 'danger' : session.error_category === 'agent' ? 'retrying' : 'neutral'}>
            {session.error_category}
          </Badge>
        ) : null}
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
    return <div className="chat-divider my-4">{message.content}</div>
  }

  if (message.type === 'error') {
    return (
      <div className="chat-message border-l-4 border-th-danger/40 pl-4 py-3">
        <div className="text-xs font-medium text-th-danger mb-1">Error</div>
        <div className="whitespace-pre-wrap break-words text-sm leading-6 text-th-text-2">{message.content}</div>
      </div>
    )
  }

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
            <div key={String(item.id)} className="rounded-lg bg-th-muted/50 px-3 py-2">
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

function runtimeForTimeline(sessions: TimelineSession[], now: number) {
  const active = sessions.findLast((session: TimelineSession) => session.live)
  if (!active) return 'Inactive'
  return runtimeSince(active.started_at, now)
}

function messageLabel(type: string) {
  switch (type) {
    case 'response': return 'Response'
    case 'error': return 'Error'
    default: return titleCase(type)
  }
}

function toolTone(status: unknown): 'neutral' | 'retrying' | 'danger' | 'live' {
  switch (status) {
    case 'completed': return 'live'
    case 'failed': return 'danger'
    case 'running': return 'retrying'
    default: return 'neutral'
  }
}
