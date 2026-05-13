// Project schemas (v1).
//
// A project ties a Linear team to a GitHub repo + per-team runtime
// defaults (engine, model, max_turns, etc.). v1 surface is strict
// create (no upsert); the dashboard handler keeps upsert semantics
// for UX reasons.
//
// Full spec: docs/linear_agent_api_v1.md ("Resources → Projects").

import { z } from "zod";

// Shared field shapes — no `.default(...)` calls. Defaults are added
// only on the Create schema below, so PUT bodies that omit a field
// don't accidentally overwrite the live row with a default value.
const projectFieldShapes = {
  linear_team_id:         z.string().min(1),
  linear_team_name:       z.string().optional(),
  repo_url:               z.string().regex(/^https?:\/\/.+/),
  default_branch:         z.string().min(1),
  engine:                 z.string().min(1),
  model:                  z.string().nullable().optional(),
  max_turns:              z.number().int().positive().max(100).optional(),
  scope:                  z.string().nullable().optional(),
  system_prompt_override: z.string().nullable().optional(),
};

export const ProjectCreateSchema = z.object({
  ...projectFieldShapes,
  default_branch: projectFieldShapes.default_branch.default("main"),
  engine: projectFieldShapes.engine.default("pi"),
});
export type ProjectCreateInput = z.infer<typeof ProjectCreateSchema>;

// Update — everything optional, NO defaults. Linear team id is
// editable but the (org, linear_team_id) uniqueness invariant still
// applies. See note on WorkflowUpdateSchema for why we don't just
// `.partial()` the Create schema.
export const ProjectUpdateSchema = z.object(projectFieldShapes).partial();
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateSchema>;

export const ProjectSchema = ProjectCreateSchema.extend({
  id:               z.string(),
  organization_id:  z.string(),
  created_at:       z.number().int(),
  updated_at:       z.number().int(),
});
export type Project = z.infer<typeof ProjectSchema>;
