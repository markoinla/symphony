// Workflow + trigger types for the dashboard. These mirror the SYM-295
// plan's contract so the UI can be developed in parallel with the
// foundation track.
//
// TODO(track-1): replace these stubs with `z.infer<typeof ...>` from
// `workers/linear-agent/src/schemas/{workflow,trigger}.ts` once Agent 1
// lands those schemas. The shapes here are the source of truth for the
// dashboard until then.

import { z } from 'zod'

// ── Event types (mirrors src/schemas/event.ts) ──────────────────────

export const eventTypeSchema = z.enum([
  'state_entered',
  'state_exited',
  'assignee_changed',
  'label_added',
  'label_removed',
  'comment_added',
  'session_started',
])
export type EventType = z.infer<typeof eventTypeSchema>

// ── Trigger actions ────────────────────────────────────────────────

export const triggerActionSchema = z.enum([
  'start_session',
  'continue_session',
  'reset_session',
  'stop_session',
  'post_comment',
  'transition_to',
])
export type TriggerAction = z.infer<typeof triggerActionSchema>

// ── Workflow scope (kept org-only in UI for now; future team/user
// pills accommodated by extending the union here) ──────────────────

export const workflowScopeSchema = z.enum(['organization', 'team', 'user'])
export type WorkflowScope = z.infer<typeof workflowScopeSchema>

export const permissionModeSchema = z.enum(['ask', 'auto', 'danger'])
export type PermissionMode = z.infer<typeof permissionModeSchema>

// ── MCP servers ────────────────────────────────────────────────────

export const mcpServerSchema = z.object({
  name: z.string(),
  url: z.string(),
  kind: z.enum(['http', 'sse', 'stdio']).default('http'),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
})
export type McpServer = z.infer<typeof mcpServerSchema>

// ── Workflow config ────────────────────────────────────────────────

export const workflowConfigSchema = z.object({
  engine: z.string().default('codex'),
  model: z.string().default('claude-sonnet-4-6'),
  max_turns: z.number().int().positive().default(20),
  max_continuations: z.number().int().nonnegative().default(0),
  allowed_tools: z.array(z.string()).default([]),
  disallowed_tools: z.array(z.string()).default([]),
  permission_mode: permissionModeSchema.default('ask'),
  allowed_domains: z.array(z.string()).default([]),
  additional_read_paths: z.array(z.string()).default([]),
  additional_write_paths: z.array(z.string()).default([]),
  hook_after_create: z.string().nullable().default(null),
  hook_before_remove: z.string().nullable().default(null),
  hook_timeout_ms: z.number().int().positive().default(30_000),
  mcp_servers: z.array(mcpServerSchema).default([]),
})
export type WorkflowConfig = z.infer<typeof workflowConfigSchema>

// ── Workflow record ────────────────────────────────────────────────

export const workflowSchema = z.object({
  id: z.string(),
  organization_id: z.string().nullable(),
  team_id: z.string().nullable(),
  user_id: z.string().nullable(),
  scope: workflowScopeSchema,
  scope_label: z.string().nullable().optional(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(['draft', 'published']),
  current_version: z.number().int().nonnegative().default(1),
  config: workflowConfigSchema,
  prompt_template: z.string().default(''),
  created_at: z.string(),
  updated_at: z.string(),
})
export type Workflow = z.infer<typeof workflowSchema>

// ── Trigger record ─────────────────────────────────────────────────

export const triggerSchema = z.object({
  id: z.string(),
  workflow_id: z.string(),
  event_type: eventTypeSchema,
  // event-type-specific match fields — only those relevant to the
  // event_type carry values; the rest are null.
  from_state: z.string().nullable().default(null),
  to_state: z.string().nullable().default(null),
  label_match: z.string().nullable().default(null),
  assignee_match: z.string().nullable().default(null),
  // scope filters — all chip lists are AND-of-OR semantics.
  team_filter: z.array(z.string()).default([]),
  project_filter: z.array(z.string()).default([]),
  label_filter: z.array(z.string()).default([]),
  skip_label_filter: z.array(z.string()).default([]),
  assignee_filter: z.array(z.string()).default([]),
  action: triggerActionSchema,
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  created_at: z.string(),
  updated_at: z.string(),
})
export type Trigger = z.infer<typeof triggerSchema>

// ── CRUD request bodies ────────────────────────────────────────────

export type WorkflowCreateBody = {
  name: string
  description?: string | null
  scope: WorkflowScope
  template?: string // template id from the gallery, e.g. "engineering_default"
  config?: Partial<WorkflowConfig>
  prompt_template?: string
}

export type WorkflowUpdateBody = Partial<{
  name: string
  description: string | null
  config: WorkflowConfig
  prompt_template: string
}>

export type TriggerCreateBody = Omit<Trigger, 'id' | 'created_at' | 'updated_at'>
export type TriggerUpdateBody = Partial<TriggerCreateBody>

// ── Preview request/response (POST /workflows/:id/preview) ─────────

export type WorkflowPreviewRequest = {
  issue_id?: string
  issue_identifier?: string
}

export type WorkflowPreviewResponse = {
  prompt: string
  context: Record<string, unknown>
}

// ── Helpers ─────────────────────────────────────────────────────────

export function emptyWorkflowConfig(): WorkflowConfig {
  return workflowConfigSchema.parse({})
}

export function emptyTrigger(workflowId: string): TriggerCreateBody {
  return {
    workflow_id: workflowId,
    event_type: 'state_entered',
    from_state: null,
    to_state: null,
    label_match: null,
    assignee_match: null,
    team_filter: [],
    project_filter: [],
    label_filter: [],
    skip_label_filter: [],
    assignee_filter: [],
    action: 'start_session',
    priority: 0,
    enabled: true,
  }
}

// Templates surfaced in the "New workflow" gallery. Track 3 will seed an
// actual "Engineering Default" workflow on first webhook; this is just
// the UI's catalogue of what the user can pick from.
export type WorkflowTemplate = {
  id: string
  name: string
  description: string
}

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: 'engineering_default',
    name: 'Engineering Default',
    description:
      'Start a Codex session when an issue moves to Todo. Includes the six baseline triggers from the SYM-295 spec.',
  },
]
