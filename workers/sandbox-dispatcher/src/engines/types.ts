/**
 * Engine-agnostic event envelope emitted by `/run` when the caller asks
 * for `Accept: text/event-stream`. Each engine adapter (pi today,
 * codex/claude later) parses its raw stdout lines into this shape so
 * the linear-agent Worker can drive Linear activities without knowing
 * which engine produced the work.
 *
 * Wire format: SSE with `data: <json-encoded NormalizedEvent>` lines,
 * separated by blank lines. The stream terminates with exactly one
 * `result` event carrying exit_code + duration_ms; the connection
 * closes immediately after.
 *
 * Symphony's `lib/symphony_elixir/linear/activity_mapper.ex:1-153` is
 * the reference for the pi mapping. The intent is that those activity
 * shapes (thought / action / response / error) round-trip from any
 * engine via this envelope.
 *
 * IMPORTANT: this file's shape is mirrored in
 * `workers/linear-agent/src/lib/event-mapper.ts`. The two files do not
 * import from each other — they're separate workers — but a change
 * here must be matched there.
 */

export type NormalizedEvent =
  | { type: "thought"; turn?: number; text: string }
  | {
      type: "tool_call";
      turn?: number;
      tool: string;
      args?: unknown;
      tool_id?: string;
    }
  | {
      type: "tool_result";
      turn?: number;
      tool_id?: string;
      ok: boolean;
      result?: string;
    }
  | { type: "assistant_msg"; turn?: number; text: string }
  | {
      type: "turn_end";
      turn: number;
      reason: "completed" | "needs_continuation" | "error";
    }
  | { type: "error"; message: string }
  | {
      type: "result";
      exit_code: number;
      duration_ms: number;
      // Reserved for item 4 (PR flow). Always null today.
      branch: string | null;
      pr_url: string | null;
    };

export interface EngineAdapter {
  /**
   * Parse a single newline-terminated stdout chunk from the engine
   * subprocess into zero or more normalized events. Adapters are
   * stateless: a partial line on the wire must be buffered by the
   * caller before being handed in.
   */
  parseEvents(line: string): NormalizedEvent[];
}
