/**
 * Pi engine adapter — translates `pi --print --mode json` NDJSON output
 * into NormalizedEvent records.
 *
 * Pi emits one JSON object per stdout line. The schemas we observe in
 * practice (mirrored in tests against fixture stdout):
 *
 *   { "type": "session", "id": "..." }                          — drop
 *   { "type": "agent_start" }                                   — drop
 *   { "type": "turn_start" }                                    — drop
 *   { "type": "message_start", "message": { "role": "user" } }  — drop
 *   { "type": "message_end",
 *     "message": { "role": "assistant",
 *                  "content": [ { "type":"text", "text":"..." } ] } }
 *     → { type: "assistant_msg", text: "..." }
 *   { "type": "message_update",
 *     "assistantMessageEvent": { "type":"text_delta", "delta":"..." } }
 *     → currently dropped (the message_end carries the full text);
 *       a future change could publish these as fine-grained streaming
 *       text events. For now we keep activity volume low.
 *   { "type": "agent_end" }                                     — drop
 *
 * Pi does not currently surface structured tool-call events on stdout;
 * tool use is internal. If pi grows a `tool_use` event later, this is
 * where it lands.
 *
 * The `turn` field on the produced events is filled in by the dispatcher
 * caller, not by this adapter — adapters are turn-agnostic.
 */

import type { EngineAdapter, NormalizedEvent } from "./types";

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
  assistantMessageEvent?: { type?: string; delta?: string };
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

    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = (event.message.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      if (text.length === 0) return [];
      return [{ type: "assistant_msg", text }];
    }

    // Everything else (session/lifecycle/text_delta/user-role
    // message_end) is intentionally dropped today. The runtime that
    // collects events still has access to raw stdout via the
    // dispatcher's buffered branch if it needs the full transcript.
    return [];
  },
};
