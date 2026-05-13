/**
 * Map normalized engine events (from sandbox-dispatcher's SSE response)
 * to Linear Agent Activity content shapes. Port of Symphony's
 * `lib/symphony_elixir/linear/activity_mapper.ex:1-153`.
 *
 * The mapping intentionally drops most events the dispatcher emits.
 * Linear's session timeline becomes unreadable above ~1 activity/sec
 * for a sustained run, so we surface the user-meaningful signals
 * (assistant messages, tool starts, errors) and let the buffered
 * `result` event carry the rest.
 *
 *   NormalizedEvent              → Linear AgentActivityContent
 *   thought       → { type: "thought", body }
 *   tool_call     → { type: "action",  action: tool, parameter, ephemeral: true }
 *   tool_result   → { type: "action",  action: "tool_result", parameter, result, ephemeral: true }
 *                   (ok=false → { type: "error", body })
 *   assistant_msg → null (held back; surfaced as the terminal
 *                         `response` activity by SessionRunner)
 *   turn_end      → null (turn boundary is implicit in subsequent activities)
 *   error         → { type: "error", body }
 *   result        → null (handled separately by SessionRunner)
 *
 * Interim tool activities (`tool_call`, successful `tool_result`) are
 * marked `ephemeral: true` so Linear can collapse / hide them once the
 * session moves on, per the agent-interaction docs. Thoughts, errors,
 * and failed tool results stay non-ephemeral so they remain visible.
 */

import type { AgentActivityContent } from "../types/agent-session";
import type { NormalizedEvent } from "./dispatcher";

const THOUGHT_LIMIT = 1000;
const TOOL_PARAM_LIMIT = 300;
const TOOL_RESULT_LIMIT = 500;
const ERROR_LIMIT = 500;

export function mapToActivity(
  event: NormalizedEvent,
): AgentActivityContent | null {
  switch (event.type) {
    case "thought":
      return { type: "thought", body: truncate(event.text, THOUGHT_LIMIT) };

    case "tool_call":
      // Interim tool activities are marked `ephemeral` so Linear can
      // collapse / hide them once the session moves on, keeping the
      // timeline readable on long runs. Final response/error stays
      // non-ephemeral so users always have a record of the outcome.
      return {
        type: "action",
        action: event.tool,
        parameter: truncate(stringifyArgs(event.args), TOOL_PARAM_LIMIT),
        ephemeral: true,
      };

    case "tool_result":
      if (event.ok) {
        return {
          type: "action",
          action: "tool_result",
          parameter: event.tool_id ?? "",
          result: truncate(event.result ?? "", TOOL_RESULT_LIMIT),
          ephemeral: true,
        };
      }
      // Tool failures stay non-ephemeral — errors must stick.
      return {
        type: "error",
        body: truncate(event.result ?? "tool_call_failed", ERROR_LIMIT),
      };

    case "error":
      return { type: "error", body: truncate(event.message, ERROR_LIMIT) };

    case "assistant_msg":
    case "turn_end":
    case "result":
      // SessionRunner handles these directly — assistant_msg becomes
      // the terminal `response` activity, result drives the workflow
      // outcome, turn_end advances the loop.
      return null;
  }
}

/**
 * Pull the "last full assistant message" out of an event stream so
 * the terminal Linear `response` activity gets a meaningful body
 * instead of just "Run finished in 12.3s." Matches the role of
 * `summarizeStdout` for the buffered branch.
 */
export function lastAssistantText(events: NormalizedEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === "assistant_msg" && e.text.length > 0) return e.text;
  }
  return null;
}

function stringifyArgs(args: unknown): string {
  if (typeof args === "string") return args;
  if (args == null) return "";
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function truncate(s: string, limit: number): string {
  return s.length <= limit ? s : s.slice(0, limit) + "…";
}
