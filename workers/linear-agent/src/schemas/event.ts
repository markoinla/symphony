// Event schemas for the workflow trigger system (SYM-295).
//
// A `webhook` handler turns a Linear delivery into an `EventTuple` —
// the normalized shape the resolver matches triggers against. Each
// event_type carries its own subset of fields (state transitions vs.
// label changes vs. comments) so the discriminated union below lets
// callers destructure narrowly.
//
// The resolver also reads `organization_id`, `team_id`, `user_id`,
// `project_id`, `labels`, and `assignee_id` from the tuple to evaluate
// trigger scope filters — these are present on every variant.

import { z } from "zod";

export const eventTypeSchema = z.enum([
  "session_started",
  "state_entered",
  "state_exited",
  "comment_added",
  "label_added",
  "label_removed",
  "assignee_changed",
]);
export type EventType = z.infer<typeof eventTypeSchema>;

// Issue payload carried on every event. Mirrors the subset of Linear's
// GraphQL `Issue` that the resolver + prompt renderer reference. All
// non-id fields are optional — webhooks sometimes omit them (e.g. an
// Issue create event won't have a state transition).
export const issueRefSchema = z.object({
  id: z.string(),
  identifier: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  state_id: z.string().nullable().optional(),
  team_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  assignee_id: z.string().nullable().optional(),
  labels: z.array(z.string()).default([]),
  parent_issue: z
    .object({
      id: z.string(),
      identifier: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  // Comments resolved up to the moment the event fires. Used by the
  // Liquid renderer; not by the resolver.
  comments: z
    .array(
      z.object({
        id: z.string(),
        body: z.string(),
        author_id: z.string().nullable().optional(),
        created_at: z.number().int().nullable().optional(),
      }),
    )
    .default([]),
});
export type IssueRef = z.infer<typeof issueRefSchema>;

// Fields that the resolver evaluates against `workflow_triggers` scope
// filters. Present on every event_type variant.
const scopeFields = {
  organization_id: z.string(),
  team_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
  assignee_id: z.string().nullable().optional(),
  labels: z.array(z.string()).default([]),
  issue: issueRefSchema.nullable().optional(),
  actor_id: z.string().nullable().optional(),
} as const;

// ── Event variants ─────────────────────────────────────────────────

export const sessionStartedEventSchema = z.object({
  event_type: z.literal("session_started"),
  ...scopeFields,
  // Optional Linear AgentSession id when one is already minted.
  agent_session_id: z.string().nullable().optional(),
});

export const stateEnteredEventSchema = z.object({
  event_type: z.literal("state_entered"),
  ...scopeFields,
  to_state: z.string(),
  from_state: z.string().nullable().optional(),
});

export const stateExitedEventSchema = z.object({
  event_type: z.literal("state_exited"),
  ...scopeFields,
  from_state: z.string(),
  to_state: z.string().nullable().optional(),
});

export const commentAddedEventSchema = z.object({
  event_type: z.literal("comment_added"),
  ...scopeFields,
  comment: z.string(),
  comment_id: z.string().nullable().optional(),
});

export const labelAddedEventSchema = z.object({
  event_type: z.literal("label_added"),
  ...scopeFields,
  label_name: z.string(),
  label_id: z.string().nullable().optional(),
});

export const labelRemovedEventSchema = z.object({
  event_type: z.literal("label_removed"),
  ...scopeFields,
  label_name: z.string(),
  label_id: z.string().nullable().optional(),
});

export const assigneeChangedEventSchema = z.object({
  event_type: z.literal("assignee_changed"),
  ...scopeFields,
  to_assignee_id: z.string().nullable().optional(),
  from_assignee_id: z.string().nullable().optional(),
});

// EventTuple — discriminated union by event_type. The resolver,
// dispatcher, and renderer all consume this shape.
export const EventTupleSchema = z.discriminatedUnion("event_type", [
  sessionStartedEventSchema,
  stateEnteredEventSchema,
  stateExitedEventSchema,
  commentAddedEventSchema,
  labelAddedEventSchema,
  labelRemovedEventSchema,
  assigneeChangedEventSchema,
]);
export type EventTuple = z.infer<typeof EventTupleSchema>;

// Legacy alias — keep so existing imports from other tracks compile.
export const eventTupleSchema = EventTupleSchema;
