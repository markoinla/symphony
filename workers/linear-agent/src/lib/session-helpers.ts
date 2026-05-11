/**
 * Pure helpers shared between the legacy `runSession` path in
 * `routes/webhook.ts` and the durable `SessionRunner` Workflow in
 * `workflows/session-runner.ts`. These are deterministic functions of
 * (env, event) — safe to call inside a Workflow step or outside one.
 */

import type { Env } from "../index";
import type {
  AgentSession,
  AgentSessionEventWebhook,
} from "../types/agent-session";

interface ProjectMapping {
  [linearTeamId: string]: string;
}

/**
 * Resolve the repository URL for a session by mapping `issue.teamId` →
 * repo URL via `PROJECT_MAPPINGS_JSON`. Returns null when no mapping is
 * configured for the team. Item 3 replaces this with a D1 lookup.
 */
export function resolveRepoUrl(env: Env, session: AgentSession): string | null {
  const teamId = session.issue?.teamId ?? session.issue?.team?.id;
  if (!teamId) return null;
  let mapping: ProjectMapping;
  try {
    mapping = JSON.parse(env.PROJECT_MAPPINGS_JSON || "{}") as ProjectMapping;
  } catch {
    return null;
  }
  return mapping[teamId] ?? null;
}

/**
 * Pull the user's actual question out of the webhook payload.
 *
 * Linear's AgentSessionEvent webhook envelopes are NOT what older docs
 * suggest — the rich context lives at the top level of the event, not
 * inside `agentSession`. Fields we draw from, in priority order:
 *
 *   - `event.promptContext` — pre-rendered markdown with the issue
 *     title, description, and any kickoff comment. This is the
 *     primary source for assignment-style sessions.
 *   - `event.agentSession.comment.body` — the actual comment body when
 *     the session is started by an @-mention.
 *   - `event.agentSession.issue.title` — last-resort fallback so we
 *     never error out for "no prompt" if Linear sent a session-start
 *     event with only the issue header.
 *
 * `event.guidance`, when present, is appended as a "Guidance:" section
 * so workspace-level instructions (e.g. "always run lint before
 * proposing edits") reach the model.
 *
 * Strips literal `@<bot-name>` tokens so the model doesn't waste
 * attention parsing them.
 */
export function resolvePrompt(event: AgentSessionEventWebhook): string | null {
  const session = event.agentSession;
  const candidates = [
    event.promptContext,
    session.comment?.body,
    session.issue?.title && session.issue?.title.trim().length > 0
      ? `Issue ${session.issue.identifier ?? ""}: ${session.issue.title}`.trim()
      : null,
  ];

  let base: string | null = null;
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const stripped = c.replace(/@[A-Za-z0-9_-]+/g, "").trim();
    if (stripped.length > 0) {
      base = stripped;
      break;
    }
  }
  if (!base) return null;

  const guidance =
    typeof event.guidance === "string" && event.guidance.trim().length > 0
      ? event.guidance.trim()
      : null;
  return guidance ? `${base}\n\n---\nGuidance:\n${guidance}` : base;
}

interface PiMessageContent {
  type?: string;
  text?: string;
}

interface PiMessageEnd {
  type?: string;
  message?: {
    role?: string;
    content?: PiMessageContent[];
  };
  assistantMessageEvent?: { type?: string; delta?: string };
}

/**
 * Extract a human-readable answer from pi's `--mode json` event stream.
 *
 * Pi emits one JSON event per line. Lifecycle events (`session`,
 * `agent_start`, etc.) are noise; the answer lives in `message_end`
 * events whose `message.role === "assistant"` and contain a
 * `content[].type === "text"` chunk. A single run may produce several
 * assistant messages (after thinking, after each tool call, then the
 * final answer) — we want the LAST one with text content.
 *
 * Fallback chain: last assistant text → reconstructed from
 * `text_delta` events → truncated raw stdout.
 */
export function summarizeStdout(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);

  let lastAssistantText: string | null = null;
  const deltaChunks: string[] = [];

  for (const line of lines) {
    let ev: PiMessageEnd;
    try {
      ev = JSON.parse(line) as PiMessageEnd;
    } catch {
      continue;
    }
    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      const text = (ev.message.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      if (text.length > 0) lastAssistantText = text;
    }
    if (
      ev.type === "message_update" &&
      ev.assistantMessageEvent?.type === "text_delta" &&
      typeof ev.assistantMessageEvent.delta === "string"
    ) {
      deltaChunks.push(ev.assistantMessageEvent.delta);
    }
  }

  if (lastAssistantText) return lastAssistantText;
  const reconstructed = deltaChunks.join("");
  if (reconstructed.length > 0) return reconstructed;
  return truncate(stdout, 2000);
}

export function truncate(s: string, limit: number): string {
  return s.length <= limit ? s : s.slice(0, limit) + "\n…[truncated]";
}
