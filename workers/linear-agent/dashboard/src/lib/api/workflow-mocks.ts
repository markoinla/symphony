// In-memory fixtures backing the workflows dashboard until Agent 2's
// /api/v1/* routes ship. Flip `USE_MOCK_WORKFLOWS_API` to false (or set
// the env to "false") to bypass these and hit the real backend.
//
// TODO(track-2): remove this entire file once /api/v1/workflows* lands.

import {
  emptyTrigger,
  emptyWorkflowConfig,
  type Trigger,
  type TriggerCreateBody,
  type TriggerUpdateBody,
  type Workflow,
  type WorkflowCreateBody,
  type WorkflowPreviewRequest,
  type WorkflowPreviewResponse,
  type WorkflowUpdateBody,
} from './workflow-types'

// /api/v1/workflows* is live (SYM-295 track 2). Set to true locally if
// you want to develop the UI without a Worker running.
export const USE_MOCK_WORKFLOWS_API = false

function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function nowIso() {
  return new Date().toISOString()
}

const initialPromptTemplate = `# {{ issue.identifier }} — {{ issue.title }}

You are picking up Linear issue **{{ issue.identifier }}**.

**Current state:** {{ issue.state }}
**Attempt:** {{ attempt }}

## Issue body
{{ prompt_context }}

{% if new_comments and new_comments.size > 0 %}
## New comments since last attempt
{% for comment in new_comments %}
- {{ comment.author }}: {{ comment.body }}
{% endfor %}
{% endif %}

## Labels
{{ issue.labels | join: ", " }}

Stay in scope. Open a PR when ready.
`

function seedEngineeringDefault(): { workflow: Workflow; triggers: Trigger[] } {
  const wid = newId('wf')
  const ts = nowIso()
  const workflow: Workflow = {
    id: wid,
    organization_id: 'org_mock',
    team_id: null,
    user_id: null,
    scope: 'organization',
    scope_label: 'Org',
    name: 'Engineering Default',
    description:
      'Start a Codex session when an issue moves to Todo. Posts result to Human Review.',
    status: 'published',
    current_version: 1,
    config: {
      ...emptyWorkflowConfig(),
      engine: 'codex',
      model: 'claude-sonnet-4-6',
      max_turns: 30,
      max_continuations: 1,
      allowed_tools: ['bash', 'edit', 'read', 'write'],
      disallowed_tools: ['rm -rf'],
      permission_mode: 'ask',
      allowed_domains: ['github.com', 'linear.app'],
      additional_read_paths: [],
      additional_write_paths: [],
      hook_after_create: null,
      hook_before_remove: null,
      hook_timeout_ms: 30_000,
      mcp_servers: [],
    },
    prompt_template: initialPromptTemplate,
    created_at: ts,
    updated_at: ts,
  }

  const triggers: Trigger[] = [
    {
      ...emptyTrigger(wid),
      id: newId('trg'),
      event_type: 'state_entered',
      to_state: 'Todo',
      action: 'start_session',
      priority: 100,
      created_at: ts,
      updated_at: ts,
    },
    {
      ...emptyTrigger(wid),
      id: newId('trg'),
      event_type: 'state_entered',
      to_state: 'In Progress',
      action: 'continue_session',
      priority: 90,
      created_at: ts,
      updated_at: ts,
    },
    {
      ...emptyTrigger(wid),
      id: newId('trg'),
      event_type: 'state_entered',
      to_state: 'Rework',
      action: 'continue_session',
      priority: 80,
      created_at: ts,
      updated_at: ts,
    },
    {
      ...emptyTrigger(wid),
      id: newId('trg'),
      event_type: 'state_exited',
      from_state: 'In Progress',
      action: 'stop_session',
      priority: 70,
      created_at: ts,
      updated_at: ts,
    },
    {
      ...emptyTrigger(wid),
      id: newId('trg'),
      event_type: 'comment_added',
      action: 'post_comment',
      priority: 60,
      created_at: ts,
      updated_at: ts,
    },
    {
      ...emptyTrigger(wid),
      id: newId('trg'),
      event_type: 'label_added',
      label_match: 'rework',
      action: 'reset_session',
      priority: 50,
      created_at: ts,
      updated_at: ts,
    },
  ]

  return { workflow, triggers }
}

type Store = {
  workflows: Map<string, Workflow>
  triggers: Map<string, Trigger>
}

const store: Store = (() => {
  const s: Store = { workflows: new Map(), triggers: new Map() }
  const { workflow, triggers } = seedEngineeringDefault()
  s.workflows.set(workflow.id, workflow)
  for (const t of triggers) s.triggers.set(t.id, t)
  return s
})()

function listWorkflows(): Workflow[] {
  return Array.from(store.workflows.values()).sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  )
}

function getWorkflow(id: string): Workflow {
  const wf = store.workflows.get(id)
  if (!wf) throw new Error(`workflow ${id} not found`)
  return wf
}

function createWorkflow(body: WorkflowCreateBody): Workflow {
  const id = newId('wf')
  const ts = nowIso()
  const config = { ...emptyWorkflowConfig(), ...(body.config ?? {}) }
  const wf: Workflow = {
    id,
    organization_id: 'org_mock',
    team_id: null,
    user_id: null,
    scope: body.scope,
    scope_label: body.scope === 'organization' ? 'Org' : null,
    name: body.name,
    description: body.description ?? null,
    status: 'draft',
    current_version: 1,
    config,
    prompt_template: body.prompt_template ?? initialPromptTemplate,
    created_at: ts,
    updated_at: ts,
  }
  store.workflows.set(id, wf)

  // If template is engineering_default, also seed example triggers.
  if (body.template === 'engineering_default') {
    const seeded = seedEngineeringDefault().triggers.map((t) => ({
      ...t,
      id: newId('trg'),
      workflow_id: id,
    }))
    for (const t of seeded) store.triggers.set(t.id, t)
  }
  return wf
}

function updateWorkflow(id: string, body: WorkflowUpdateBody): Workflow {
  const wf = getWorkflow(id)
  const next: Workflow = {
    ...wf,
    ...('name' in body && body.name !== undefined ? { name: body.name } : {}),
    ...('description' in body ? { description: body.description ?? null } : {}),
    ...(body.config ? { config: body.config } : {}),
    ...('prompt_template' in body && body.prompt_template !== undefined
      ? { prompt_template: body.prompt_template }
      : {}),
    updated_at: nowIso(),
  }
  store.workflows.set(id, next)
  return next
}

function deleteWorkflow(id: string) {
  store.workflows.delete(id)
  for (const [tid, trigger] of store.triggers) {
    if (trigger.workflow_id === id) store.triggers.delete(tid)
  }
}

function publishWorkflow(id: string): Workflow {
  const wf = getWorkflow(id)
  const next: Workflow = {
    ...wf,
    status: 'published',
    current_version: wf.current_version + 1,
    updated_at: nowIso(),
  }
  store.workflows.set(id, next)
  return next
}

function duplicateWorkflow(id: string): Workflow {
  const src = getWorkflow(id)
  return createWorkflow({
    name: `${src.name} (copy)`,
    description: src.description,
    scope: src.scope,
    config: src.config,
    prompt_template: src.prompt_template,
  })
}

function listTriggers(workflowId: string): Trigger[] {
  return Array.from(store.triggers.values())
    .filter((t) => t.workflow_id === workflowId)
    .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at))
}

function createTrigger(body: TriggerCreateBody): Trigger {
  const id = newId('trg')
  const ts = nowIso()
  const trigger: Trigger = {
    ...body,
    id,
    created_at: ts,
    updated_at: ts,
  }
  store.triggers.set(id, trigger)
  return trigger
}

function updateTrigger(id: string, body: TriggerUpdateBody): Trigger {
  const existing = store.triggers.get(id)
  if (!existing) throw new Error(`trigger ${id} not found`)
  const next: Trigger = {
    ...existing,
    ...body,
    updated_at: nowIso(),
  }
  store.triggers.set(id, next)
  return next
}

function deleteTrigger(id: string) {
  store.triggers.delete(id)
}

function previewWorkflow(
  id: string,
  req: WorkflowPreviewRequest,
): WorkflowPreviewResponse {
  const wf = getWorkflow(id)
  const fakeIssue = {
    id: req.issue_id ?? 'mock_issue_1',
    identifier: req.issue_identifier ?? 'SYM-MOCK',
    title: 'Sample issue title for preview',
    state: 'Todo',
    labels: ['feature', 'backend'],
    comments: [],
    parent_issue: null,
  }
  const context = {
    issue: fakeIssue,
    attempt: 1,
    prompt_context:
      'This is a stand-in issue body. Track 2 will populate this from Linear.',
    new_comments: [],
  }
  // Naive {{ var }} substitution so the preview looks right even
  // without a real Liquid renderer. The real /preview endpoint will use
  // Track 1's renderer.
  const rendered = wf.prompt_template
    .replace(/\{\{\s*issue\.(\w+)\s*\}\}/g, (_, k) => {
      const v = (fakeIssue as Record<string, unknown>)[k]
      if (Array.isArray(v)) return v.join(', ')
      return v == null ? '' : String(v)
    })
    .replace(/\{\{\s*attempt\s*\}\}/g, String(context.attempt))
    .replace(/\{\{\s*prompt_context\s*\}\}/g, context.prompt_context)
  return { prompt: rendered, context }
}

export const mockApi = {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  publishWorkflow,
  duplicateWorkflow,
  listTriggers,
  createTrigger,
  updateTrigger,
  deleteTrigger,
  previewWorkflow,
}
