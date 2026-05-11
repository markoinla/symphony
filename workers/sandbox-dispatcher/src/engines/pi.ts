/**
 * Pi engine adapter — translates `pi --print --mode json` NDJSON output
 * into NormalizedEvent records.
 *
 * Pi's event schema is documented in its `AgentEvent` (lifecycle +
 * tool_execution_*) and `AssistantMessageEvent` (the
 * `assistantMessageEvent` field on `message_update`) types:
 *   node_modules/@mariozechner/pi-ai/dist/types.d.ts
 *   node_modules/@mariozechner/pi-coding-agent/docs/json.md
 *
 * We surface the user-meaningful subset and drop streaming deltas to
 * keep Linear's activity volume sane (the timeline becomes unreadable
 * above ~1 activity/sec). Mapping:
 *
 *   tool_execution_start                      → tool_call
 *   tool_execution_end (isError=false)        → tool_result ok=true
 *   tool_execution_end (isError=true)         → tool_result ok=false
 *   message_update / thinking_end             → thought (full block)
 *   message_end (role=assistant, text blocks) → assistant_msg
 *   turn_start                                → thought ("Calling model…")
 *
 * Dropped:
 *   session, agent_start, agent_end, turn_end (lifecycle)
 *   message_start                             (consolidated by message_end)
 *   message_update / text_delta|text_start|text_end (high volume; final
 *                                             text comes via message_end)
 *   message_update / thinking_delta|thinking_start (consolidated by
 *                                             thinking_end)
 *   message_update / toolcall_*               (model planning the call;
 *                                             actual invocation is
 *                                             tool_execution_*)
 *   tool_execution_update                     (partial tool output;
 *                                             final result comes via _end)
 *   user-role message_end                     (the input we sent)
 *
 * The `turn` field on the produced events is filled in by the dispatcher
 * caller, not by this adapter — adapters are turn-agnostic.
 */

import type { EngineAdapter, NormalizedEvent } from "./types";

interface PiContent {
  type?: string;
  text?: string;
}

interface PiToolResultContent {
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
  // tool_execution_* shapes
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: {
    content?: PiToolResultContent[];
  } | string | null;
  isError?: boolean;
}

export const piEngineAdapter: EngineAdapter = {
  parseEvents(line: string): NormalizedEvent[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) return [];

    let event: PiMessageEvent;
    try {
      event = JSON.parse(trimmed) as PiMessageEvent;
    } catch {
      // Pi shouldn't emit non-JSON, but tolerate it — the legacy
      // summarizeStdout fallback handles the same case for the
      // backwards-compat blob response.
      return [];
    }

    if (event.type === "turn_start") {
      // Per-turn heartbeat. The first turn_start fires right after the
      // dispatcher's "Calling model (…)" prep thought, which is a
      // tolerable duplicate; subsequent turn_starts (one per
      // tool-result loop) give a clear separator in the timeline
      // before the next model response begins streaming.
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
      const text = extractToolResultText(event.result);
      return [
        {
          type: "tool_result",
          tool_id: event.toolCallId,
          ok: !event.isError,
          result: text,
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
  },
};

function extractToolResultText(result: PiMessageEvent["result"]): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const blocks = result.content ?? [];
  return blocks
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}
