/**
 * Pure helpers shared between routes and the durable `SessionRunner`
 * Workflow. These are deterministic functions of (env, event) — safe
 * to call inside a Workflow step or outside one.
 */

import type { AgentSessionEventWebhook } from "../types/agent-session";

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
  const withGuidance = guidance
    ? `${base}\n\n---\nGuidance:\n${guidance}`
    : base;

  const priorBlock = renderPreviousComments(event.previousComments);
  return priorBlock ? `${priorBlock}\n\n---\n\n${withGuidance}` : withGuidance;
}

/**
 * Render the "Prior comments:" preamble Linear gives us on the webhook
 * envelope (`event.previousComments`, chronological). Caps at the 10
 * most recent comments and truncates each body to keep the prompt
 * compact — long threads regularly run past the context budget.
 *
 * Returns `null` when the array is missing or has no usable entries
 * so callers can compose `priorBlock ? ... : original` cleanly.
 */
function renderPreviousComments(
  comments: AgentSessionEventWebhook["previousComments"],
): string | null {
  if (!Array.isArray(comments) || comments.length === 0) return null;
  // Linear sends comments in chronological order — take the tail so
  // we surface the most recent context first when truncated.
  const recent = comments.slice(-10);
  const lines: string[] = [];
  for (const c of recent) {
    if (!c || typeof c.body !== "string") continue;
    const stripped = c.body.replace(/@[A-Za-z0-9_-]+/g, "").trim();
    if (stripped.length === 0) continue;
    const truncated = truncate(stripped, 500);
    const userTag = c.userId ? `(userId: ${c.userId}) ` : "";
    lines.push(`- ${userTag}${truncated}`);
  }
  if (lines.length === 0) return null;
  return `Prior comments:\n${lines.join("\n")}`;
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
