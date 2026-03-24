import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'

import {
  type SessionStatsRange,
  type DeadLetterSession,
  type WorkerHostStats,
  getSessionStats,
} from '../lib/api'
import {
  Card,
  CardHeader,
  CardTitle,
  Badge,
  EmptyState,
  LoadingPanel,
  ErrorPanel,
} from '../components/ui'
import { formatQueryError } from '../lib/helpers'

const RANGE_OPTIONS: SessionStatsRange[] = ['24h', '7d', '30d']

const CATEGORY_COLORS: Record<string, string> = {
  infra: '#ef4444',
  agent: '#f97316',
  config: '#eab308',
  timeout: '#3b82f6',
}

function formatBucket(bucket: string, range: SessionStatsRange) {
  const d = new Date(bucket)
  if (range === '24h') {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function categoryTone(category: string | null) {
  switch (category) {
    case 'infra': return 'danger' as const
    case 'agent': return 'retrying' as const
    case 'config': return 'neutral' as const
    case 'timeout': return 'live' as const
    default: return 'neutral' as const
  }
}

export function ReliabilityView() {
  const [range, setRange] = useState<SessionStatsRange>('24h')

  const statsQuery = useQuery({
    queryKey: ['session-stats', range],
    queryFn: () => getSessionStats(range),
  })

  if (statsQuery.isPending) {
    return <LoadingPanel title="Loading reliability data" />
  }

  if (statsQuery.isError) {
    return <ErrorPanel title="Reliability data unavailable" detail={formatQueryError(statsQuery.error)} />
  }

  const { failure_counts, dead_letters, worker_health } = statsQuery.data
  const sortedWorkers = [...worker_health].sort((a, b) => b.failure_rate - a.failure_rate)

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-th-text-1">Reliability</h1>
          <p className="mt-1 text-sm text-th-text-3">Failure rates, dead letters, and worker health.</p>
        </div>

        <div className="flex gap-1">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt}
              onClick={() => setRange(opt)}
              className={
                'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors duration-100 ' +
                (opt === range
                  ? 'bg-th-accent text-white'
                  : 'bg-th-muted text-th-text-3 hover:text-th-text-1')
              }
              type="button"
            >
              {opt}
            </button>
          ))}
        </div>
      </div>

      {/* Section 1: Failure Rate Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Failures by category</CardTitle>
        </CardHeader>
        {failure_counts.every((b) => b.infra + b.agent + b.config + b.timeout === 0) ? (
          <EmptyState
            icon={
              <svg className="h-5 w-5 text-th-text-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            title="No failures in this period"
            description="All sessions completed successfully."
          />
        ) : (
          <div className="mt-4" style={{ height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={failure_counts}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-th-border, #e5e7eb)" />
                <XAxis
                  dataKey="bucket"
                  tickFormatter={(v: string) => formatBucket(v, range)}
                  tick={{ fontSize: 12 }}
                  stroke="var(--color-th-text-4, #9ca3af)"
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 12 }}
                  stroke="var(--color-th-text-4, #9ca3af)"
                  width={40}
                />
                <Tooltip
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  labelFormatter={(label: any) => formatBucket(String(label), range)}
                  contentStyle={{
                    backgroundColor: 'var(--color-th-surface, #fff)',
                    border: '1px solid var(--color-th-border, #e5e7eb)',
                    borderRadius: '8px',
                    fontSize: '13px',
                  }}
                />
                <Bar dataKey="infra" stackId="failures" fill={CATEGORY_COLORS.infra} name="Infra" />
                <Bar dataKey="agent" stackId="failures" fill={CATEGORY_COLORS.agent} name="Agent" />
                <Bar dataKey="config" stackId="failures" fill={CATEGORY_COLORS.config} name="Config" />
                <Bar dataKey="timeout" stackId="failures" fill={CATEGORY_COLORS.timeout} name="Timeout" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Section 2: Dead Letter Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Dead letters</CardTitle>
        </CardHeader>
        {dead_letters.length === 0 ? (
          <EmptyState
            icon={
              <svg className="h-5 w-5 text-th-text-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            title="No dead letters"
            description="All failed sessions have been retried."
          />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-th-border text-th-text-3">
                  <th className="whitespace-nowrap py-2 pr-4 font-medium">Issue</th>
                  <th className="whitespace-nowrap py-2 pr-4 font-medium">Workflow</th>
                  <th className="whitespace-nowrap py-2 pr-4 font-medium">Category</th>
                  <th className="whitespace-nowrap py-2 pr-4 font-medium">Error</th>
                  <th className="whitespace-nowrap py-2 font-medium">Ended At</th>
                </tr>
              </thead>
              <tbody>
                {dead_letters.map((dl) => (
                  <DeadLetterRow key={dl.id} session={dl} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Section 3: Worker Host Health */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Worker health</CardTitle>
        </CardHeader>
        {sortedWorkers.length === 0 ? (
          <EmptyState
            icon={
              <svg className="h-5 w-5 text-th-text-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            title="No worker data"
            description="Worker health metrics will appear once sessions have run."
          />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-th-border text-th-text-3">
                  <th className="whitespace-nowrap py-2 pr-4 font-medium">Host</th>
                  <th className="whitespace-nowrap py-2 pr-4 font-medium text-right">Total Runs</th>
                  <th className="whitespace-nowrap py-2 pr-4 font-medium text-right">Failures</th>
                  <th className="whitespace-nowrap py-2 font-medium text-right">Failure Rate</th>
                </tr>
              </thead>
              <tbody>
                {sortedWorkers.map((worker) => (
                  <WorkerRow key={worker.host} worker={worker} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function DeadLetterRow({ session }: { session: DeadLetterSession }) {
  const endedAt = session.ended_at
    ? new Date(session.ended_at).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—'

  const issueCell = session.issue_identifier ? (
    <Link
      className="text-th-accent hover:underline"
      to="/session/$issueIdentifier"
      params={{ issueIdentifier: session.issue_identifier }}
    >
      {session.issue_identifier}
    </Link>
  ) : (
    <span className="text-th-text-4">—</span>
  )

  return (
    <tr className="border-b border-th-border/50 text-th-text-2">
      <td className="py-2.5 pr-4 font-medium text-th-text-1">{issueCell}</td>
      <td className="py-2.5 pr-4">{session.workflow_name ?? '—'}</td>
      <td className="py-2.5 pr-4">
        {session.error_category ? (
          <Badge tone={categoryTone(session.error_category)}>{session.error_category}</Badge>
        ) : (
          <span className="text-th-text-4">—</span>
        )}
      </td>
      <td className="max-w-xs truncate py-2.5 pr-4" title={session.error ?? undefined}>
        {session.error ? session.error.slice(0, 80) : '—'}
      </td>
      <td className="whitespace-nowrap py-2.5 tabular-nums">{endedAt}</td>
    </tr>
  )
}

function WorkerRow({ worker }: { worker: WorkerHostStats }) {
  const rate = (worker.failure_rate * 100).toFixed(1)
  const highFailure = worker.failure_rate > 0.5

  return (
    <tr className={'border-b border-th-border/50 ' + (highFailure ? 'bg-th-danger-muted/50 text-th-danger' : 'text-th-text-2')}>
      <td className="py-2.5 pr-4 font-medium text-th-text-1">{worker.host}</td>
      <td className="py-2.5 pr-4 text-right tabular-nums">{worker.total_runs}</td>
      <td className="py-2.5 pr-4 text-right tabular-nums">{worker.failures}</td>
      <td className="py-2.5 text-right tabular-nums">{rate}%</td>
    </tr>
  )
}
