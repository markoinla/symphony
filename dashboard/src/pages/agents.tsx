import { useState } from 'react'
import * as Collapsible from '@radix-ui/react-collapsible'
import { Bot, ChevronRight, Plus } from 'lucide-react'

import { cn } from '../lib/utils'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Textarea,
} from '../components/ui'

type MockAgent = {
  name: string
  description: string
  enabled: boolean
  engine: string
  concurrency: number
  polling_interval: number
  max_turns: number
  prompt_template: string
  config: Record<string, unknown>
}

const mockAgents: MockAgent[] = [
  {
    name: 'WORKFLOW',
    description: 'Main development workflow — picks up issues, writes code, creates PRs.',
    enabled: true,
    engine: 'codex',
    concurrency: 3,
    polling_interval: 30,
    max_turns: 20,
    prompt_template:
      'You are a software engineering agent. Given a Linear issue, analyze the requirements,\nimplement the changes, write tests, and create a pull request.\n\nFollow the project conventions in CLAUDE.md and AGENTS.md.',
    config: {
      engine: 'codex',
      concurrency: 3,
      polling_interval: 30,
      max_turns: 20,
      labels: ['symphony'],
      states: { trigger: 'Todo', in_progress: 'In Progress', done: 'Done' },
    },
  },
  {
    name: 'TRIAGE',
    description: 'Triages incoming issues — adds labels, estimates complexity, suggests approach.',
    enabled: true,
    engine: 'codex',
    concurrency: 5,
    polling_interval: 15,
    max_turns: 5,
    prompt_template:
      'You are a triage agent. Analyze the incoming issue and:\n1. Estimate complexity (low/medium/high)\n2. Suggest labels\n3. Write a suggested approach as a comment',
    config: {
      engine: 'codex',
      concurrency: 5,
      polling_interval: 15,
      max_turns: 5,
      labels: ['needs-triage'],
      states: { trigger: 'Triage', done: 'Todo' },
    },
  },
  {
    name: 'ENRICHMENT',
    description: 'Enriches issues with context — links related issues, adds documentation refs.',
    enabled: false,
    engine: 'codex',
    concurrency: 2,
    polling_interval: 60,
    max_turns: 8,
    prompt_template:
      'You are an enrichment agent. For each issue:\n1. Search for related issues and link them\n2. Find relevant documentation and add references\n3. Identify potential blockers',
    config: {
      engine: 'codex',
      concurrency: 2,
      polling_interval: 60,
      max_turns: 8,
      labels: [],
      states: { trigger: 'Backlog', done: 'Backlog' },
    },
  },
]

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
  agent: MockAgent | null
}) {
  const [showAdvanced, setShowAdvanced] = useState(false)

  if (!agent) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={agent.name} description={agent.description}>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Engine">
              <Input readOnly value={agent.engine} />
            </Field>
            <Field label="Concurrency">
              <Input readOnly type="number" value={agent.concurrency} />
            </Field>
            <Field label="Polling interval (seconds)">
              <Input readOnly type="number" value={agent.polling_interval} />
            </Field>
            <Field label="Max turns">
              <Input readOnly type="number" value={agent.max_turns} />
            </Field>
          </div>

          <Field label="Prompt template">
            <Textarea
              className="min-h-[160px] font-mono text-xs leading-5"
              readOnly
              value={agent.prompt_template}
            />
          </Field>

          <Collapsible.Root onOpenChange={setShowAdvanced} open={showAdvanced}>
            <Collapsible.Trigger className="group flex w-full items-center gap-1.5 rounded-md py-1.5 text-xs font-medium text-th-text-3 transition hover:text-th-text-1">
              <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
              Raw JSON config
            </Collapsible.Trigger>
            <Collapsible.Content>
              <pre className="mt-3 overflow-auto rounded-lg border border-th-border bg-th-inset p-4 font-mono text-xs leading-5 text-th-text-3">
                {JSON.stringify(agent.config, null, 2)}
              </pre>
            </Collapsible.Content>
          </Collapsible.Root>

          <div className="flex items-center justify-end gap-3 border-t border-th-border pt-4">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              Close
            </Button>
            <Button type="button">Save changes</Button>
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
}: {
  agent: MockAgent
  onView: (agent: MockAgent) => void
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
          </div>

          <p className="text-[13px] leading-5 text-th-text-3">{agent.description}</p>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-th-text-4">
            <span>Engine: {agent.engine}</span>
            <span>Concurrency: {agent.concurrency}</span>
            <span>Poll: {agent.polling_interval}s</span>
            <span>Max turns: {agent.max_turns}</span>
          </div>
        </div>

        <Button
          className="shrink-0"
          onClick={() => onView(agent)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Edit
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function AgentsView() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<MockAgent | null>(null)

  function handleView(agent: MockAgent) {
    setSelectedAgent(agent)
    setDialogOpen(true)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-th-text-1">Agents</h1>
          <p className="mt-1 text-sm text-th-text-3">
            Manage agent definitions — configure workflows, prompt templates, and runtime settings.
          </p>
        </div>
        <Button className="shrink-0" type="button">
          <Plus className={cn('mr-1.5 h-3.5 w-3.5')} />
          New agent
        </Button>
      </div>

      {mockAgents.length === 0 ? (
        <EmptyState
          icon={<Bot className="h-5 w-5 text-th-text-4" />}
          title="No agents yet"
          description="Create your first agent to start automating workflows."
        />
      ) : null}

      <div className="grid gap-3">
        {mockAgents.map((agent) => (
          <AgentCard key={agent.name} agent={agent} onView={handleView} />
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
