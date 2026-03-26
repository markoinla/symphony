import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'

import { type CostRange, getCostAnalytics, type WorkflowBreakdown } from '../lib/api'
import { formatNumber } from '../lib/utils'
import {
  Card,
  CardHeader,
  CardTitle,
  EmptyState,
  LoadingPanel,
  ErrorPanel,
} from '../components/ui'
import { formatQueryError } from '../lib/helpers'

const RANGE_OPTIONS: CostRange[] = ['24h', '7d', '30d', '90d']

const WORKFLOW_COLORS = [
  '#64748b', // slate
  '#78716c', // stone
  '#71717a', // zinc
  '#6b7280', // gray
  '#9ca3af', // gray-light
  '#a1a1aa', // zinc-light
  '#a8a29e', // stone-light
  '#94a3b8', // slate-light
  '#737373', // neutral
  '#8b8b8b', // neutral-light
]

function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`
}

function formatDate(dateStr: string, range: CostRange = '30d') {
  if (range === '24h') {
    const d = new Date(dateStr)
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

type SortKey = keyof Pick<
  WorkflowBreakdown,
  'workflow' | 'sessions' | 'input_tokens' | 'output_tokens' | 'cost_cents' | 'avg_cost_cents_per_session'
>

type SortDir = 'asc' | 'desc'

export function AnalyticsView() {
  const [range, setRange] = useState<CostRange>('30d')
  const [sortKey, setSortKey] = useState<SortKey>('cost_cents')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const analyticsQuery = useQuery({
    queryKey: ['analytics', 'cost', range],
    queryFn: () => getCostAnalytics(range),
  })

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortedWorkflows = useMemo(() => {
    if (!analyticsQuery.data) return []
    const items = [...analyticsQuery.data.by_workflow]
    items.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
    })
    return items
  }, [analyticsQuery.data, sortKey, sortDir])

  // Build chart data: pivot daily entries into { date, [workflow]: cost_dollars }
  const { chartData, workflows } = useMemo(() => {
    if (!analyticsQuery.data) return { chartData: [], workflows: [] }

    const wfSet = new Set<string>()
    const dateMap = new Map<string, Record<string, string | number>>()

    for (const entry of analyticsQuery.data.daily) {
      wfSet.add(entry.workflow)
      let existing = dateMap.get(entry.date)
      if (!existing) {
        existing = { date: entry.date }
        dateMap.set(entry.date, existing)
      }
      existing[entry.workflow] = ((existing[entry.workflow] as number) || 0) + entry.cost_cents / 100
    }

    const sortedDates = [...dateMap.keys()].sort()
    return {
      chartData: sortedDates.map((d) => dateMap.get(d)!),
      workflows: [...wfSet].sort(),
    }
  }, [analyticsQuery.data])

  if (analyticsQuery.isPending) {
    return <LoadingPanel title="Loading analytics" />
  }

  if (analyticsQuery.isError) {
    return <ErrorPanel title="Analytics unavailable" detail={formatQueryError(analyticsQuery.error)} />
  }

  const { summary, daily } = analyticsQuery.data

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-th-text-1">Analytics</h1>
          <p className="mt-1 text-sm text-th-text-3">Cost and token usage across workflows.</p>
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

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Cost" value={formatDollars(summary.total_cost_cents)} />
        <SummaryCard label="Total Sessions" value={String(summary.total_sessions)} />
        <SummaryCard label="Input Tokens" value={formatNumber(summary.total_input_tokens)} />
        <SummaryCard label="Output Tokens" value={formatNumber(summary.total_output_tokens)} />
      </div>

      {daily.length === 0 && summary.total_cost_cents === 0 && summary.total_sessions === 0 ? (
        <EmptyState
          icon={
            <svg className="h-5 w-5 text-th-text-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path d="M3 3v18h18" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M7 16l4-8 4 4 4-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
          title="No cost data for this period"
          description="Analytics are recorded for sessions started after deployment."
        />
      ) : (
        <>
          {/* Cost over time chart */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Cost over time</CardTitle>
            </CardHeader>
            <div className="mt-4" style={{ height: 400 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-th-border, #e5e7eb)" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(v: string) => formatDate(v, range)}
                    tick={{ fontSize: 12 }}
                    stroke="var(--color-th-text-4, #9ca3af)"
                  />
                  <YAxis
                    tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                    tick={{ fontSize: 12 }}
                    stroke="var(--color-th-text-4, #9ca3af)"
                    width={60}
                  />
                  <Tooltip
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    formatter={(value: any) => [`$${Number(value).toFixed(2)}`]}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    labelFormatter={(label: any) => formatDate(String(label), range)}
                    contentStyle={{
                      backgroundColor: 'var(--color-th-surface, #fff)',
                      border: '1px solid var(--color-th-border, #e5e7eb)',
                      borderRadius: '8px',
                      fontSize: '13px',
                    }}
                  />
                  {workflows.map((wf, i) => (
                    <Bar
                      key={wf}
                      dataKey={wf}
                      stackId="cost"
                      fill={WORKFLOW_COLORS[i % WORKFLOW_COLORS.length]}
                      radius={i === workflows.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {/* Workflow breakdown table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Workflow breakdown</CardTitle>
            </CardHeader>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-th-border text-th-text-3">
                    <SortableHeader label="Workflow" sortKey="workflow" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
                    <SortableHeader label="Sessions" sortKey="sessions" currentKey={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
                    <SortableHeader label="Input Tokens" sortKey="input_tokens" currentKey={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
                    <SortableHeader label="Output Tokens" sortKey="output_tokens" currentKey={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
                    <SortableHeader label="Total Cost" sortKey="cost_cents" currentKey={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
                    <SortableHeader label="Avg Cost/Session" sortKey="avg_cost_cents_per_session" currentKey={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
                  </tr>
                </thead>
                <tbody>
                  {sortedWorkflows.map((wf) => (
                    <tr key={wf.workflow} className="border-b border-th-border/50 text-th-text-2">
                      <td className="py-2.5 pr-4 font-medium text-th-text-1">{wf.workflow}</td>
                      <td className="py-2.5 pr-4 text-right">{wf.sessions}</td>
                      <td className="py-2.5 pr-4 text-right">{formatNumber(wf.input_tokens)}</td>
                      <td className="py-2.5 pr-4 text-right">{formatNumber(wf.output_tokens)}</td>
                      <td className="py-2.5 pr-4 text-right">{formatDollars(wf.cost_cents)}</td>
                      <td className="py-2.5 text-right">{formatDollars(wf.avg_cost_cents_per_session)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <p className="text-[13px] text-th-text-3">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-th-text-1">{value}</p>
    </Card>
  )
}

function SortableHeader({
  label,
  sortKey,
  currentKey,
  dir,
  onSort,
  className,
}: {
  label: string
  sortKey: SortKey
  currentKey: SortKey
  dir: SortDir
  onSort: (key: SortKey) => void
  className?: string
}) {
  const active = sortKey === currentKey
  return (
    <th
      className={
        'cursor-pointer select-none whitespace-nowrap py-2 pr-4 font-medium ' +
        (active ? 'text-th-text-1 ' : '') +
        (className ?? '')
      }
      onClick={() => onSort(sortKey)}
    >
      {label}
      {active ? (dir === 'asc' ? ' \u2191' : ' \u2193') : ''}
    </th>
  )
}
