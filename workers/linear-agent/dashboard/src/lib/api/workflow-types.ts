// Dashboard-facing types for the workflows + triggers REST surface.
//
// All shapes come from the Worker's Zod schemas via the @server/*
// path alias (see ../../tsconfig.app.json + ../../vite.config.ts).
// That alias resolves to `workers/linear-agent/src/*`, so the dashboard
// and the API speak the exact same wire shape — no second source of
// truth, no adapter layer.
//
// The schema modules only import `zod`, so they're browser-safe.

import { z } from 'zod'

import {
  EventTupleSchema,
  eventTypeSchema,
  type EventTuple as ServerEventTuple,
  type EventType as ServerEventType,
} from '@server/schemas/event'
import {
  TriggerCreateSchema,
  TriggerSchema,
  TriggerUpdateSchema,
  triggerActionSchema,
  type Trigger as ServerTrigger,
  type TriggerAction as ServerTriggerAction,
} from '@server/schemas/trigger'
import {
  WorkflowCreateSchema,
  WorkflowSchema,
  WorkflowUpdateSchema,
  engineSchema,
  mcpServerSchema as serverMcpServerSchema,
  permissionModeSchema,
  workflowStatusSchema,
  type McpServer as ServerMcpServer,
  type Workflow as ServerWorkflow,
  type WorkflowStatus as ServerWorkflowStatus,
} from '@server/schemas/workflow'

// ── Re-exports ─────────────────────────────────────────────────────
//
// Schemas first (runtime parsers in case forms want client-side
// validation), then inferred types for components.

export {
  EventTupleSchema,
  eventTypeSchema,
  TriggerCreateSchema,
  TriggerSchema,
  TriggerUpdateSchema,
  triggerActionSchema,
  WorkflowCreateSchema,
  WorkflowSchema,
  WorkflowUpdateSchema,
  engineSchema,
  permissionModeSchema,
  workflowStatusSchema,
}

export const mcpServerSchema = serverMcpServerSchema

export type EventType = ServerEventType
export type EventTuple = ServerEventTuple
export type TriggerAction = ServerTriggerAction
export type Trigger = ServerTrigger
export type Workflow = ServerWorkflow
export type WorkflowStatus = ServerWorkflowStatus
export type McpServer = ServerMcpServer

// Request body types use `z.input` so fields with Zod `.default(...)`
// stay optional from the client's perspective. The server applies the
// defaults during validation and returns the fully-resolved Workflow.
export type WorkflowCreateBody = z.input<typeof WorkflowCreateSchema>
export type WorkflowUpdateBody = z.input<typeof WorkflowUpdateSchema>
export type TriggerCreateBody = z.input<typeof TriggerCreateSchema>
export type TriggerUpdateBody = z.input<typeof TriggerUpdateSchema>

// ── Dashboard-only display helpers ─────────────────────────────────
//
// Scope is derived from which of organization_id/team_id/user_id is
// non-null. The DB CHECK guarantees exactly one is set.

export type WorkflowScope = 'organization' | 'team' | 'user'

export function workflowScope(workflow: Workflow): WorkflowScope {
  if (workflow.user_id) return 'user'
  if (workflow.team_id) return 'team'
  return 'organization'
}

export function workflowScopeLabel(workflow: Workflow): string {
  const scope = workflowScope(workflow)
  if (scope === 'organization') return 'Org'
  if (scope === 'team') return `Team: ${workflow.team_id ?? '—'}`
  return `User: ${workflow.user_id ?? '—'}`
}

// Backend stores timestamps as Unix seconds (matches D1 INTEGER column).
// Render helpers format them for the UI.

export function formatWorkflowTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString()
}

// ── Preview request/response (POST /workflows/:id/preview) ─────────
//
// The Worker route accepts `{ issue_id }` and returns `{ rendered }`
// — see workers/linear-agent/src/routes/api-v1.ts. We don't expose
// these as Zod schemas server-side because the route shape is
// API-layer-only, but mirroring them here keeps the hook typed.

export const workflowPreviewRequestSchema = z.object({
  issue_id: z.string().min(1),
})
export type WorkflowPreviewRequest = z.infer<typeof workflowPreviewRequestSchema>

export const workflowPreviewResponseSchema = z.object({
  rendered: z.string(),
})
export type WorkflowPreviewResponse = z.infer<typeof workflowPreviewResponseSchema>

// ── Trigger draft helper (used by the "Add trigger" button) ────────

export function newTriggerDraft(): TriggerCreateBody {
  return {
    event_type: 'state_entered',
    to_state: null,
    from_state: null,
    label_name: null,
    comment_match: null,
    team_filter: null,
    project_filter: null,
    label_filter: null,
    skip_label_filter: null,
    assignee_filter: null,
    action: 'start_session',
    action_params: null,
    priority: 0,
    enabled: true,
  }
}

// ── New-workflow template gallery ──────────────────────────────────
//
// Templates live entirely on the client — they're just convenient
// starting payloads for POST /api/v1/workflows. Track 3's seed.ts
// installs an "Engineering Default" row server-side on the first
// webhook for an org; the gallery is for users to clone alternatives
// after that.

export const engineeringDefaultPromptTemplate = `# {{ issue.identifier }} — {{ issue.title }}

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

export type WorkflowTemplate = {
  id: string
  name: string
  description: string
  body: WorkflowCreateBody
}

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: 'engineering_default',
    name: 'Engineering Default',
    description:
      'Start a Codex session when an issue moves to Todo. Mirrors the six baseline triggers from the SYM-295 spec — add triggers separately on the Triggers tab.',
    body: {
      name: 'Engineering Default',
      description:
        'Start a Codex session when an issue moves to Todo. Posts result to Human Review.',
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
      prompt_template: engineeringDefaultPromptTemplate,
    },
  },
]
