import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Webhook } from 'lucide-react'

import {
  getWebhook,
  getWebhooks,
  type WebhookEvent,
} from '../lib/api'
import { formatQueryError } from '../lib/helpers'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui'
import { EmptyState, ErrorPanel, LoadingPanel } from '../components/feedback'
import { cn } from '../lib/utils'

const REFETCH_INTERVAL_MS = 3000

export function WebhooksView() {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const listQuery = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => getWebhooks({ limit: 100 }),
    refetchInterval: REFETCH_INTERVAL_MS,
  })

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-th-text-1">
          Webhooks
        </h1>
        <p className="mt-1 text-sm text-th-text-3">
          Live tail of Linear webhook deliveries. Verifies the chain
          from inbound signature through trigger resolution to agent
          dispatch.
        </p>
      </div>

      {listQuery.isPending ? (
        <LoadingPanel title="Loading webhook events" />
      ) : listQuery.isError ? (
        <ErrorPanel
          title="Webhook events unavailable"
          detail={formatQueryError(listQuery.error)}
        />
      ) : listQuery.data.webhooks.length === 0 ? (
        <EmptyState
          icon={<Webhook className="h-5 w-5 text-th-text-4" />}
          title="No webhook deliveries yet"
          description="Trigger an issue state change in Linear to see it here within a few seconds."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recent deliveries</CardTitle>
            <CardDescription className="text-[13px]">
              Refreshes every {REFETCH_INTERVAL_MS / 1000}s. Click a row
              for the raw payload.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-th-border">
              {listQuery.data.webhooks.map((row) => (
                <WebhookRow
                  key={row.id}
                  row={row}
                  expanded={expandedId === row.id}
                  onToggle={() =>
                    setExpandedId((current) =>
                      current === row.id ? null : row.id,
                    )
                  }
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function WebhookRow({
  row,
  expanded,
  onToggle,
}: {
  row: WebhookEvent
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div>
      <Button
        type="button"
        onClick={onToggle}
        variant="ghost"
        className="grid h-auto w-full grid-cols-[auto_auto_1fr_auto_auto] items-center justify-start gap-3 rounded-none px-4 py-3 text-left font-normal hover:bg-th-muted"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 text-th-text-4 transition-transform',
            expanded ? 'rotate-90' : '',
          )}
        />
        <span className="font-mono text-xs text-th-text-4">
          {formatReceivedAt(row.received_at)}
        </span>
        <span className="flex min-w-0 items-center gap-2 truncate">
          <Badge variant={badgeVariant(row.envelope_type)}>
            {row.envelope_type}
            {row.envelope_action ? ` · ${row.envelope_action}` : ''}
          </Badge>
          <span className="truncate text-[13px] text-th-text-2">
            {row.event_summary ?? '—'}
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-xs text-th-text-3">
          {row.signature_ok ? (
            <span className="text-th-success">sig ✓</span>
          ) : (
            <span className="text-th-danger">sig ✗</span>
          )}
          {row.deduped ? <span>deduped</span> : null}
        </span>
        <DispatchedBadge action={row.dispatched_action} />
      </Button>

      {expanded ? (
        <div className="bg-th-muted/40 px-4 pb-4">
          <DetailGrid row={row} />
          <RawBodyDrawer id={row.id} fallback={row.raw_body ?? ''} />
        </div>
      ) : null}
    </div>
  )
}

function DispatchedBadge({ action }: { action: string }) {
  const tone =
    action === 'start_session'
      ? 'success'
      : action === 'pending'
        ? 'info'
        : action === 'error'
          ? 'danger'
          : 'muted'
  const cls =
    tone === 'success'
      ? 'bg-th-success-muted text-th-success'
      : tone === 'danger'
        ? 'bg-th-danger-muted text-th-danger'
        : tone === 'info'
          ? 'bg-th-accent/15 text-th-accent'
          : 'bg-th-muted text-th-text-3'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] font-medium',
        cls,
      )}
    >
      {action}
    </span>
  )
}

function DetailGrid({ row }: { row: WebhookEvent }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 py-3 text-[12px] sm:grid-cols-2">
      <DetailField label="ID" value={row.id} mono />
      <DetailField label="Source ID" value={row.source_id ?? '—'} mono />
      <DetailField label="Webhook ID" value={row.webhook_id ?? '—'} mono />
      <DetailField label="Latency" value={`${row.latency_ms} ms`} />
      <DetailField label="Org" value={row.organization_id ?? '—'} mono />
      <DetailField
        label="Workflow"
        value={row.matched_workflow_id ?? '—'}
        mono
      />
      <DetailField
        label="Trigger"
        value={row.matched_trigger_id ?? '—'}
        mono
      />
      <DetailField
        label="Agent session"
        value={row.agent_session_id ?? '—'}
        mono
      />
      {row.error ? (
        <DetailField
          label="Error"
          value={row.error}
          className="sm:col-span-2 text-th-danger"
        />
      ) : null}
    </dl>
  )
}

function DetailField({
  label,
  value,
  mono = false,
  className,
}: {
  label: string
  value: string
  mono?: boolean
  className?: string
}) {
  return (
    <div className={cn('grid grid-cols-[110px_1fr] items-baseline gap-3', className)}>
      <dt className="text-th-text-4">{label}</dt>
      <dd
        className={cn(
          'truncate text-th-text-2',
          mono ? 'font-mono text-[11px]' : '',
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}

function RawBodyDrawer({ id, fallback }: { id: string; fallback: string }) {
  const detailQuery = useQuery({
    queryKey: ['webhook', id],
    queryFn: () => getWebhook(id),
    staleTime: 30_000,
  })
  const body = detailQuery.data?.webhook.raw_body ?? fallback
  return (
    <div className="mt-2">
      <p className="mb-1 text-[11px] uppercase tracking-wide text-th-text-4">
        Raw body
      </p>
      <pre className="max-h-96 overflow-auto rounded-md border border-th-border bg-th-bg p-3 font-mono text-[11px] leading-relaxed text-th-text-2">
        {prettyJson(body)}
      </pre>
    </div>
  )
}

function prettyJson(s: string): string {
  if (!s) return ''
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

function badgeVariant(envelope: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (envelope === 'AgentSessionEvent') return 'default'
  if (envelope === 'Issue') return 'secondary'
  return 'outline'
}

function formatReceivedAt(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}
