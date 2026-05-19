/**
 * Pi engine event handling for the engine-push path (SYM-386).
 *
 * In the push architecture the sandbox forwarder POSTs raw `pi --print
 * --mode json` NDJSON lines to the ingest endpoint
 * (`/internal/run-events/:sessionId`), and *this* worker does the
 * pi → NormalizedEvent mapping — the dispatcher no longer parses pi
 * output for the pi engine.
 *
 * `parsePiLine` is a straight port of the dispatcher's
 * `piEngineAdapter.parseEvents`
 * (`workers/sandbox-dispatcher/src/engines/pi.ts`). Keep the two in
 * sync until the dispatcher-side pi adapter is removed in SYM-386
 * phase 4. The pinned mapping:
 *
 *   tool_execution_start                      → tool_call
 *   tool_execution_end                        → tool_result (ok = !isError)
 *   message_update / thinking_end             → thought (full block)
 *   message_end (role=assistant, text blocks) → assistant_msg
 *   turn_start                                → thought ("Calling model…")
 *
 * Everything else (session, agent_start, agent_end, turn_end,
 * message_start, streaming deltas, tool_execution_update) is dropped —
 * lifecycle / high-volume noise. The terminal signal is the forwarder's
 * `run_exit`, not pi's `agent_end`.
 */

import type { NormalizedEvent } from "./dispatcher";
import { truncate } from "./session-helpers";

const PRELUDE_PREFIX = "__SYMPHONY_EVENT__ ";

interface PiContent {
  type?: string;
  text?: string;
}

interface PiMessageEvent {
  type?: string;
  message?: {
    role?: string;
    content?: PiContent[];
  };
  assistantMessageEvent?: {
    type?: string;
    content?: string;
    delta?: string;
  };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?:
    | {
        content?: PiContent[];
      }
    | string
    | null;
  isError?: boolean;
}

/**
 * Parse one raw `pi --mode json` NDJSON line into normalized events.
 * Returns `[]` for dropped/lifecycle lines and for non-JSON garbage —
 * the forwarder is a dumb pipe, so tolerate anything.
 */
export function parsePiLine(line: string): NormalizedEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  if (trimmed.startsWith(PRELUDE_PREFIX)) {
    try {
      return [JSON.parse(trimmed.slice(PRELUDE_PREFIX.length)) as NormalizedEvent];
    } catch {
      return [];
    }
  }

  let event: PiMessageEvent;
  try {
    event = JSON.parse(trimmed) as PiMessageEvent;
  } catch {
    return [];
  }

  if (event.type === "turn_start") {
    return [{ type: "thought", text: "Calling model…" }];
  }

  if (event.type === "tool_execution_start") {
    if (!event.toolName) return [];
    return [
      {
        type: "tool_call",
        tool: event.toolName,
        args: event.args,
        tool_id: event.toolCallId,
      },
    ];
  }

  if (event.type === "tool_execution_end") {
    return [
      {
        type: "tool_result",
        tool_id: event.toolCallId,
        ok: !event.isError,
        result: extractToolResultText(event.result),
      },
    ];
  }

  if (
    event.type === "message_update" &&
    event.assistantMessageEvent?.type === "thinking_end"
  ) {
    const text = event.assistantMessageEvent.content ?? "";
    if (text.length === 0) return [];
    return [{ type: "thought", text }];
  }

  if (event.type === "message_end" && event.message?.role === "assistant") {
    const text = (event.message.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");
    if (text.length === 0) return [];
    return [{ type: "assistant_msg", text }];
  }

  return [];
}

function extractToolResultText(result: PiMessageEvent["result"]): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const blocks = result.content ?? [];
  return blocks
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

/**
 * Build the truncated `agent_session_events.body` for one normalized
 * event. Mirrors `summarizeOne` in `session-runner.ts`, with one
 * deliberate difference: `assistant_msg` is stored **untruncated**.
 *
 * The terminal Linear `response` activity is the run's final
 * user-facing message; truncating it to 500 chars (as the timeline
 * summary does for thoughts) would clip real output. The dashboard
 * truncates assistant messages on render instead.
 */
export function summarizeEvent(ev: NormalizedEvent): string | null {
  if (ev.type === "assistant_msg") return ev.text;
  if (ev.type === "thought") return truncate(ev.text, 500);
  if (ev.type === "tool_call") {
    const argStr =
      typeof ev.args === "string" ? ev.args : JSON.stringify(ev.args ?? "");
    return `${ev.tool}(${truncate(argStr, 200)})`;
  }
  if (ev.type === "tool_result") {
    return truncate(ev.result ?? (ev.ok ? "ok" : "error"), 200);
  }
  if (ev.type === "error") return ev.message;
  if (ev.type === "result") return `exit_code=${ev.exit_code}`;
  return null;
}
