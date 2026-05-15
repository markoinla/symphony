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
// The variable surface is fixed: generic `subject.*` / `context.*`,
// defensive per-kind sugar (`issue.*`, `pr.*`, `event.*`, `payload`),
// `attempt`, `prompt_context`, and `new_comments`. Anything passed in
// `extra` is merged in too, so callers can supply event-type-specific
// extras (e.g. `to_state`).

import { Liquid } from "liquidjs";

import type { IssueRef, SubjectRef } from "../../schemas/event";

export interface PromptContext {
  issue: IssueRef;
  subject?: SubjectRef;
  attempt: number;
  prompt_context?: string | null;
  new_comments?: Array<{ id: string; body: string; author_id?: string | null }>;
  context?: Record<string, unknown>;
  // Free-form extras merged into the Liquid scope. Event-specific
  // fields like `to_state` or `label_name` are passed here.
  extra?: Record<string, unknown>;
}

const engine = new Liquid({
  strictVariables: false,
  strictFilters: false,
  cache: false,
});

engine.registerFilter("json", (value: unknown) => JSON.stringify(value ?? null));

export async function renderPrompt(
  template: string,
  context: PromptContext,
): Promise<string> {
  const subject: SubjectRef =
    context.subject ??
    ({
      ...context.issue,
      kind: "linear_issue",
      attachments: context.issue.attachments ?? [],
    } as SubjectRef);
  const scope = {
    issue: issueScope(subject),
    pr: subject.kind === "github_pr" ? subject : {},
    event: subject.kind === "sentry_event" ? subject : {},
    payload: subject.kind === "generic" ? subject.payload : "",
    subject,
    attempt: context.attempt,
    prompt_context: context.prompt_context ?? "",
    new_comments: context.new_comments ?? [],
    context: context.context ?? {},
    ...(context.extra ?? {}),
  };
  return await engine.parseAndRender(template, scope);
}

function issueScope(subject: SubjectRef): Record<string, unknown> {
  if (subject.kind === "linear_issue") return subject;

  if (subject.kind === "github_issue") {
    return {
      ...subject,
      description: subject.body ?? subject.description ?? null,
      parent_issue: null,
      comments: [],
      attachments: [],
    };
  }

  return {};
}
