import { describe, expect, it } from "vitest";
import { createClaudeEngineAdapter } from "../src/engines/claude";

describe("claudeEngineAdapter.parseEvents", () => {
  it("drops init and tolerates blank/non-json lines", () => {
    const adapter = createClaudeEngineAdapter();
    expect(adapter.parseEvents("")).toEqual([]);
    expect(adapter.parseEvents("not json")).toEqual([]);
    expect(
      adapter.parseEvents(
        '{"type":"system","subtype":"init","session_id":"s1","model":"claude-sonnet-4-5"}',
      ),
    ).toEqual([]);
  });

  it("translates assistant text, thinking, and tool_use blocks", () => {
    const adapter = createClaudeEngineAdapter();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Need to inspect files." },
          { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "ls" } },
          { type: "text", text: "I will check the repo." },
        ],
      },
    });

    expect(adapter.parseEvents(line)).toEqual([
      { type: "thought", text: "Need to inspect files." },
      {
        type: "tool_call",
        tool: "bash",
        args: { command: "ls" },
        tool_id: "toolu_1",
      },
      { type: "assistant_msg", text: "I will check the repo." },
    ]);
  });

  it("translates user tool_result blocks", () => {
    const adapter = createClaudeEngineAdapter();
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "file1" }, { type: "text", text: "file2" }],
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            is_error: true,
            content: "boom",
          },
        ],
      },
    });

    expect(adapter.parseEvents(line)).toEqual([
      { type: "tool_result", tool_id: "toolu_1", ok: true, result: "file1\nfile2" },
      { type: "tool_result", tool_id: "toolu_2", ok: false, result: "boom" },
    ]);
  });

  it("turns result chunks into sequential turn_end events", () => {
    const adapter = createClaudeEngineAdapter();
    expect(adapter.parseEvents('{"type":"result","subtype":"success"}')).toEqual([
      { type: "turn_end", turn: 1, reason: "completed" },
    ]);
    expect(
      adapter.parseEvents(
        '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"max turns"}',
      ),
    ).toEqual([
      { type: "turn_end", turn: 2, reason: "error" },
      { type: "error", message: "max turns" },
    ]);
  });

  it("maps rate limit and api retry messages to thoughts", () => {
    const adapter = createClaudeEngineAdapter();
    expect(
      adapter.parseEvents(
        '{"type":"rate_limit_event","rate_limit_info":{"reset_at":"later"}}',
      ),
    ).toEqual([
      { type: "thought", text: 'Claude rate limit event: {"reset_at":"later"}' },
    ]);
    expect(
      adapter.parseEvents(
        '{"type":"system","subtype":"api_retry","attempt":2,"error":"overloaded"}',
      ),
    ).toEqual([
      { type: "thought", text: 'Claude API retry attempt 2: "overloaded"' },
    ]);
  });
});
