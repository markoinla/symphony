import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as Collapsible from '@radix-ui/react-collapsible'
import { Bot, ChevronRight } from 'lucide-react'

import { cn } from '../lib/utils'
import { type AgentWorkflow, getAgents, updateAgent } from '../lib/api'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Switch,
} from '../components/ui'

// ---------------------------------------------------------------------------
// Agent detail dialog
// ---------------------------------------------------------------------------

function AgentDetailDialog({
  open,
  onOpenChange,
  agent,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  agent: AgentWorkflow | null
}) {
  const [showRawConfig, setShowRawConfig] = useState(false)

  if (!agent) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={agent.name} description={agent.description ?? undefined}>
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={agent.enabled ? 'running' : 'neutral'}>
              {agent.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            {!agent.loaded && <Badge tone="neutral">Not loaded</Badge>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Engine">
              <Input readOnly value={agent.config.engine ?? '—'} />
            </Field>
            <Field label="Concurrency">
              <Input readOnly value={agent.config.max_concurrent_agents ?? '—'} />
            </Field>
            <Field label="Polling interval (ms)">
              <Input readOnly value={agent.config.polling_interval_ms ?? '—'} />
            </Field>
            <Field label="Max turns">
              <Input readOnly value={agent.config.max_turns ?? '—'} />
            </Field>
          </div>

          <Collapsible.Root onOpenChange={setShowRawConfig} open={showRawConfig}>
            <Collapsible.Trigger className="group flex w-full items-center gap-1.5 rounded-md py-1.5 text-xs font-medium text-th-text-3 transition hover:text-th-text-1">
              <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
              Raw JSON config
            </Collapsible.Trigger>
            <Collapsible.Content>
              <pre className="mt-3 overflow-auto rounded-lg border border-th-border bg-th-inset p-4 font-mono text-xs leading-5 text-th-text-3">
                {JSON.stringify(agent.raw_config, null, 2)}
              </pre>
            </Collapsible.Content>
          </Collapsible.Root>

          <div className="flex items-center justify-end gap-3 border-t border-th-border pt-4">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

function AgentCard({
  agent,
  onView,
  onToggle,
  isToggling,
}: {
  agent: AgentWorkflow
  onView: (agent: AgentWorkflow) => void
  onToggle: (agent: AgentWorkflow) => void
  isToggling: boolean
}) {
  return (
    <div className="session-card rounded-xl border border-th-border bg-th-surface p-4 transition-shadow hover:shadow-sm sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2.5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-th-text-1">{agent.name}</h3>
            <Badge tone={agent.enabled ? 'running' : 'neutral'}>
              {agent.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            {!agent.loaded && <Badge tone="neutral">Not loaded</Badge>}
          </div>

          {agent.description && (
            <p className="text-[13px] leading-5 text-th-text-3">{agent.description}</p>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-th-text-4">
            {agent.config.engine && <span>Engine: {agent.config.engine}</span>}
            {agent.config.max_concurrent_agents != null && (
              <span>Concurrency: {agent.config.max_concurrent_agents}</span>
            )}
            {agent.config.polling_interval_ms != null && (
              <span>Poll: {agent.config.polling_interval_ms}ms</span>
            )}
            {agent.config.max_turns != null && <span>Max turns: {agent.config.max_turns}</span>}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={agent.enabled}
            disabled={isToggling}
            onCheckedChange={() => onToggle(agent)}
          />
          <Button
            className="shrink-0"
            onClick={() => onView(agent)}
            size="sm"
            type="button"
            variant="ghost"
          >
            View
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function AgentsView() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<AgentWorkflow | null>(null)
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: getAgents,
    refetchInterval: 30_000,
  })

  const toggleMutation = useMutation({
    mutationFn: (agent: AgentWorkflow) => updateAgent(agent.name, { enabled: !agent.enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents'] }),
  })

  const agents = data?.agents ?? []

  function handleView(agent: AgentWorkflow) {
    setSelectedAgent(agent)
    setDialogOpen(true)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-th-text-1">Agents</h1>
        <p className="mt-1 text-sm text-th-text-3">
          Agent definitions loaded from workflow files — configure via YAML frontmatter.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-th-text-3">Loading agents…</p>
      ) : agents.length === 0 ? (
        <EmptyState
          icon={<Bot className={cn('h-5 w-5 text-th-text-4')} />}
          title="No agents found"
          description="No workflow files are loaded and no agents have been registered."
        />
      ) : null}

      <div className="grid gap-3">
        {agents.map((agent) => (
          <AgentCard
            key={agent.name}
            agent={agent}
            onView={handleView}
            onToggle={(a) => toggleMutation.mutate(a)}
            isToggling={toggleMutation.isPending}
          />
        ))}
      </div>

      <AgentDetailDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setSelectedAgent(null)
        }}
        agent={selectedAgent}
      />
    </div>
  )
}
