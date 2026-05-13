import type { EngineAdapter, NormalizedEvent } from "./types";

interface ClaudeMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: ClaudeContentBlock[];
    usage?: unknown;
  };
  rate_limit_info?: unknown;
  attempt?: unknown;
  error?: unknown;
  is_error?: boolean;
  errors?: unknown;
  result?: unknown;
}

type ClaudeContentBlock =
  | { type?: "text"; text?: string }
  | { type?: "thinking"; thinking?: string }
  | { type?: "tool_use"; id?: string; name?: string; input?: unknown }
  | {
      type?: "tool_result";
      tool_use_id?: string;
      content?: string | Array<{ type?: string; text?: string }>;
      is_error?: boolean;
    }
  | Record<string, unknown>;

export function createClaudeEngineAdapter(): EngineAdapter {
  let turn = 0;

  return {
    emitsTurnEnd: true,
    parseEvents(line: string): NormalizedEvent[] {
      const trimmed = line.trim();
      if (trimmed.length === 0) return [];

      let event: ClaudeMessage;
      try {
        event = JSON.parse(trimmed) as ClaudeMessage;
      } catch {
        return [];
      }

      if (event.type === "system" && event.subtype === "init") {
        return [];
      }

      if (event.type === "assistant") {
        return translateAssistant(event.message?.content ?? []);
      }

      if (event.type === "user") {
        return translateUser(event.message?.content ?? []);
      }

      if (event.type === "result") {
        turn += 1;
        const reason = resultReason(event);
        const events: NormalizedEvent[] = [{ type: "turn_end", turn, reason }];
        const errorText = resultErrorText(event);
        if (errorText) events.push({ type: "error", message: errorText });
        return events;
      }

      if (event.type === "rate_limit_event") {
        return [{ type: "thought", text: describeRateLimit(event.rate_limit_info) }];
      }

      if (event.type === "system" && event.subtype === "api_retry") {
        return [{ type: "thought", text: describeApiRetry(event) }];
      }

      return [];
    },
  };
}

export const claudeEngineAdapter = createClaudeEngineAdapter();

function translateAssistant(blocks: ClaudeContentBlock[]): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      events.push({ type: "assistant_msg", text: block.text });
    } else if (
      block.type === "thinking" &&
      typeof block.thinking === "string" &&
      block.thinking.length > 0
    ) {
      events.push({ type: "thought", text: block.thinking });
    } else if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : null;
      if (!name) continue;
      events.push({
        type: "tool_call",
        tool: name,
        args: "input" in block ? block.input : undefined,
        tool_id: typeof block.id === "string" ? block.id : undefined,
      });
    }
  }
  return events;
}

function translateUser(blocks: ClaudeContentBlock[]): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    events.push({
      type: "tool_result",
      tool_id: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
      ok: !block.is_error,
      result: extractToolResultText(block.content),
    });
  }
  return events;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("\n");
}

function resultReason(event: ClaudeMessage): "completed" | "needs_continuation" | "error" {
  if (event.is_error) return "error";
  if (typeof event.subtype === "string" && event.subtype !== "success") return "error";
  return "completed";
}

function resultErrorText(event: ClaudeMessage): string | null {
  if (!event.is_error && event.subtype === "success") return null;
  if (typeof event.result === "string" && event.result.length > 0) return event.result;
  if (event.errors !== undefined) return `claude_result_error: ${JSON.stringify(event.errors)}`;
  if (event.subtype && event.subtype !== "success") return `claude_result_${event.subtype}`;
  return null;
}

function describeRateLimit(info: unknown): string {
  if (info === undefined || info === null) return "Claude rate limit event.";
  return `Claude rate limit event: ${JSON.stringify(info)}`;
}

function describeApiRetry(event: ClaudeMessage): string {
  const attempt = event.attempt === undefined ? "unknown" : String(event.attempt);
  const error = event.error === undefined ? "unknown error" : JSON.stringify(event.error);
  return `Claude API retry attempt ${attempt}: ${error}`;
}
