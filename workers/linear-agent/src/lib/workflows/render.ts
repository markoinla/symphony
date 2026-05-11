// Liquid prompt renderer (SYM-295).
//
// Wraps `liquidjs` with a hardened config:
//   - `strictVariables: false` so missing keys evaluate to empty
//     strings instead of throwing. Symphony's WORKFLOW.md templates
//     reference variables that may not be populated on every event
//     (e.g. `new_comments` on the initial run); we want a benign
//     render rather than a hard fail.
//   - `strictFilters: false` for the same reason.
//   - Caching disabled — Workers reuses the renderer across requests;
//     the cache key would just retain templates we'll never re-render.
//
// The variable surface is fixed: `issue.*`, `attempt`, `prompt_context`,
// `new_comments`. Anything passed in `extra` is merged in too, so
// callers can supply event-type-specific extras (e.g. `to_state`).

import { Liquid } from "liquidjs";

import type { IssueRef } from "../../schemas/event";

export interface PromptContext {
  issue: IssueRef;
  attempt: number;
  prompt_context?: string | null;
  new_comments?: Array<{ id: string; body: string; author_id?: string | null }>;
  // Free-form extras merged into the Liquid scope. Event-specific
  // fields like `to_state` or `label_name` are passed here.
  extra?: Record<string, unknown>;
}

const engine = new Liquid({
  strictVariables: false,
  strictFilters: false,
  cache: false,
});

export async function renderPrompt(
  template: string,
  context: PromptContext,
): Promise<string> {
  const scope = {
    issue: context.issue,
    attempt: context.attempt,
    prompt_context: context.prompt_context ?? "",
    new_comments: context.new_comments ?? [],
    ...(context.extra ?? {}),
  };
  return await engine.parseAndRender(template, scope);
}
