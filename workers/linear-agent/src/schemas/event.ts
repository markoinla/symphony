// Event schemas for the workflow trigger system (SYM-295).
//
// A `webhook` handler turns an inbound delivery into an `EventTuple` —
// the normalized shape the resolver matches triggers against. Every
// event carries a `subject` discriminated union so source adapters can
// land non-Linear references at the boundary without pretending they
// are Linear issues.
//
// V1 ships multiple subject kinds:
//   - linear_issue: the existing Linear issue payload, widened with a
//     `kind` discriminator.
//   - github_issue: GitHub issue payloads that share the `issue.*`
//     prompt namespace with Linear issues.
//   - github_pr: GitHub pull request payloads exposed via `pr.*`.
//   - sentry_event: Sentry events exposed via `event.*`.
//   - generic: an external id plus opaque JSON payload for direct API
//     invocations.
//
// The resolver also reads `organization_id`, `team_id`, `user_id`,
// `project_id`, `labels`, and `assignee_id` from the tuple to evaluate
// trigger scope filters — these are present on every variant.

import { z } from "zod";

export const eventTypeSchema = z.enum([
  "api.invoke",
  "session_started",
  "state_entered",
  "state_exited",
  "comment_added",
  "label_added",
  "label_removed",
  "assignee_changed",
]);
export type EventType = z.infer<typeof eventTypeSchema>;

// Issue payload carried by Linear-originated events. Mirrors the subset
// of Linear's GraphQL `Issue` that the resolver + prompt renderer
// reference. All non-id fields are optional — webhooks sometimes omit
// them (e.g. an Issue create event won't have a state transition).
export const linearIssueSubjectSchema = z.object({
  kind: z.literal("linear_issue"),
  id: z.string(),
  identifier: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
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
  attachments: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

export const githubIssueSubjectSchema = z.object({
  kind: z.literal("github_issue"),
  id: z.string(),
  external_id: z.string().nullable().optional(),
  number: z.number().int().nullable().optional(),
  title: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  repository: z.string().nullable().optional(),
  labels: z.array(z.string()).default([]),
  assignees: z.array(z.string()).default([]),
});

export const githubPrSubjectSchema = z.object({
  kind: z.literal("github_pr"),
  id: z.string(),
  external_id: z.string().nullable().optional(),
  number: z.number().int().nullable().optional(),
  title: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  repository: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  base_branch: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  labels: z.array(z.string()).default([]),
});

export const sentryEventSubjectSchema = z.object({
  kind: z.literal("sentry_event"),
  id: z.string(),
  external_id: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
  culprit: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  level: z.string().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const genericSubjectSchema = z.object({
  kind: z.literal("generic"),
  external_id: z.string(),
  title: z.string().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const SubjectRefSchema = z.discriminatedUnion("kind", [
  linearIssueSubjectSchema,
  githubIssueSubjectSchema,
  githubPrSubjectSchema,
  sentryEventSubjectSchema,
  genericSubjectSchema,
]);
export type SubjectRef = z.infer<typeof SubjectRefSchema>;

// Backward-compatible alias for code/tests that still talk in terms of
// an IssueRef. The schema accepts the same fields as a linear subject
// without requiring the discriminator.
export const issueRefSchema = linearIssueSubjectSchema.omit({
  kind: true,
  attachments: true,
}).extend({
  kind: z.literal("linear_issue").optional(),
  attachments: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
      }),
    )
    .optional(),
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
  subject: SubjectRefSchema.optional(),
  // Legacy compatibility during the SubjectRef transition. New code
  // should read `subject`; Linear mappers populate both so existing
  // renderer/resolver paths remain unchanged.
  issue: issueRefSchema.nullable().optional(),
  actor_id: z.string().nullable().optional(),
} as const;

// ── Event variants ─────────────────────────────────────────────────

export const apiInvokeEventSchema = z.object({
  event_type: z.literal("api.invoke"),
  ...scopeFields,
  context: z.record(z.string(), z.unknown()).default({}),
});

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
  apiInvokeEventSchema,
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
