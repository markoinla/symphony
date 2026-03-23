import { useState } from 'react'
import * as Collapsible from '@radix-ui/react-collapsible'

import { cn } from '../lib/utils'
import { Badge, Button, Card, Field, Input, Textarea } from '../components/ui'

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

export function AgentsView() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>('WORKFLOW')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const agent = mockAgents.find((a) => a.name === selectedAgent)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-th-text-1">Agents</h1>
        <p className="mt-1 text-sm text-th-text-3">
          Manage agent definitions — configure workflows, prompt templates, and runtime settings.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.8fr,1.2fr]">
        <Card className="min-w-0 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight text-th-text-1">Agent definitions</h2>
            <Button size="sm" type="button">
              + New agent
            </Button>
          </div>

          <div className="space-y-2">
            {mockAgents.map((a) => (
              <button
                className={cn(
                  'w-full rounded-lg border p-4 text-left transition-colors',
                  selectedAgent === a.name
                    ? 'border-th-accent bg-th-accent-muted'
                    : 'border-th-border bg-th-inset hover:border-th-border-muted',
                )}
                key={a.name}
                onClick={() => setSelectedAgent(a.name)}
                type="button"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-semibold text-th-text-1">{a.name}</span>
                  <Badge tone={a.enabled ? 'running' : 'neutral'}>
                    {a.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </div>
                <p className="mt-1.5 text-[13px] leading-5 text-th-text-3">{a.description}</p>
                <div className="mt-3 flex flex-wrap gap-3 text-xs text-th-text-4">
                  <span>Engine: {a.engine}</span>
                  <span>Concurrency: {a.concurrency}</span>
                  <span>Poll: {a.polling_interval}s</span>
                  <span>Max turns: {a.max_turns}</span>
                </div>
              </button>
            ))}
          </div>
        </Card>

        {agent ? (
          <Card className="min-w-0 space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-th-text-1">{agent.name}</h2>
                <p className="mt-1 text-sm text-th-text-3">{agent.description}</p>
              </div>
              <Badge tone={agent.enabled ? 'running' : 'neutral'}>
                {agent.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>

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
              <Collapsible.Trigger asChild>
                <button
                  className="flex items-center gap-2 text-sm font-medium text-th-text-3 hover:text-th-text-1"
                  type="button"
                >
                  <svg
                    className={cn('h-3.5 w-3.5 transition-transform', showAdvanced && 'rotate-90')}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Advanced — Raw JSON config
                </button>
              </Collapsible.Trigger>
              <Collapsible.Content>
                <pre className="mt-3 overflow-auto rounded-lg border border-th-border bg-th-inset p-4 font-mono text-xs leading-5 text-th-text-3">
                  {JSON.stringify(agent.config, null, 2)}
                </pre>
              </Collapsible.Content>
            </Collapsible.Root>

            <div className="flex flex-col gap-3 border-t border-th-border pt-5 sm:flex-row">
              <Button type="button">Save changes</Button>
              <Button type="button" variant="secondary">
                Reset
              </Button>
              <Button className="sm:ml-auto" type="button" variant="danger">
                Delete agent
              </Button>
            </div>
          </Card>
        ) : (
          <Card className="flex min-w-0 items-center justify-center py-24">
            <p className="text-sm text-th-text-4">Select an agent to view its configuration</p>
          </Card>
        )}
      </div>
    </div>
  )
}
