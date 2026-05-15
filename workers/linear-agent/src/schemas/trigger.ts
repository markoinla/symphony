// Trigger schemas (SYM-295).
//
// Rows in `workflow_triggers` route normalized events to a workflow's
// dispatched action. The resolver evaluates each trigger's
// event-specific match columns (`to_state`, `from_state`, `label_name`,
// `comment_match`) and its scope filters (`team_filter`,
// `project_filter`, `label_filter`, `skip_label_filter`,
// `assignee_filter`) against the EventTuple.
//
// Filters are stored as JSON-encoded TEXT in D1 and surfaced as parsed
// arrays here. NULL / missing means "match any".

import { z } from "zod";

import { eventTypeSchema } from "./event";

export const triggerActionSchema = z.enum([
  "start_session",
  "continue_session",
  "reset_session",
  "stop_session",
  "post_comment",
  "transition_to",
]);
export type TriggerAction = z.infer<typeof triggerActionSchema>;

// Full trigger row — what the resolver returns and what the API
// exposes. JSON columns are surfaced as parsed arrays / objects.
export const TriggerSchema = z.object({
  id: z.string(),
  workflow_id: z.string(),

  event_type: eventTypeSchema,

  to_state: z.string().nullable().optional(),
  from_state: z.string().nullable().optional(),
  label_name: z.string().nullable().optional(),
  comment_match: z.string().nullable().optional(),

  team_filter: z.array(z.string()).nullable().optional(),
  project_filter: z.array(z.string()).nullable().optional(),
  label_filter: z.array(z.string()).nullable().optional(),
  skip_label_filter: z.array(z.string()).nullable().optional(),
  assignee_filter: z.array(z.string()).nullable().optional(),
  sentry_project_filter: z.array(z.string()).nullable().optional(),
  level_filter: z.array(z.enum(["fatal", "error", "warning", "info", "debug"])).nullable().optional(),
  fingerprint_filter: z.string().nullable().optional(),
  environment_filter: z.array(z.string()).nullable().optional(),
  release_filter: z.array(z.string()).nullable().optional(),

  action: triggerActionSchema,
  action_params: z.record(z.string(), z.unknown()).nullable().optional(),

  priority: z.number().int(),
  enabled: z.boolean(),
  expected_subject_kinds: z
    .array(z.enum(["linear_issue", "generic", "sentry_event"]))
    .nullable()
    .optional(),

  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Trigger = z.infer<typeof TriggerSchema>;

// Shared field shapes — no `.default(...)` calls. Defaults are added
// only on the Create schema, so Update bodies that omit `priority` /
// `enabled` don't reset the live row to 0 / true. See note on
// WorkflowUpdateSchema for the full reasoning.
const triggerFieldShapes = {
  event_type: eventTypeSchema,

  to_state: z.string().nullable().optional(),
  from_state: z.string().nullable().optional(),
  label_name: z.string().nullable().optional(),
  comment_match: z.string().nullable().optional(),

  team_filter: z.array(z.string()).nullable().optional(),
  project_filter: z.array(z.string()).nullable().optional(),
  label_filter: z.array(z.string()).nullable().optional(),
  skip_label_filter: z.array(z.string()).nullable().optional(),
  assignee_filter: z.array(z.string()).nullable().optional(),
  sentry_project_filter: z.array(z.string()).nullable().optional(),
  level_filter: z.array(z.enum(["fatal", "error", "warning", "info", "debug"])).nullable().optional(),
  fingerprint_filter: z.string().nullable().optional(),
  environment_filter: z.array(z.string()).nullable().optional(),
  release_filter: z.array(z.string()).nullable().optional(),

  action: triggerActionSchema,
  action_params: z.record(z.string(), z.unknown()).nullable().optional(),

  priority: z.number().int(),
  enabled: z.boolean(),
};

// Body for `POST /api/v1/workflows/:id/triggers`. The workflow_id and
// timestamps are server-applied.
export const TriggerCreateSchema = z.object({
  ...triggerFieldShapes,
  priority: triggerFieldShapes.priority.default(0),
  enabled: triggerFieldShapes.enabled.default(true),
});
export type TriggerCreateInput = z.infer<typeof TriggerCreateSchema>;

export const TriggerUpdateSchema = z.object(triggerFieldShapes).partial();
export type TriggerUpdateInput = z.infer<typeof TriggerUpdateSchema>;
