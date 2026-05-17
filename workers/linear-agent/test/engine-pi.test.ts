import { describe, expect, it } from "vitest";

import { parsePiLine, summarizeEvent } from "../src/lib/engine-pi";

describe("parsePiLine", () => {
  it("maps tool_execution_start to a tool_call", () => {
    expect(
      parsePiLine(
        JSON.stringify({
          type: "tool_execution_start",
          toolName: "bash",
          toolCallId: "t1",
          args: { cmd: "ls" },
        }),
      ),
    ).toEqual([
      { type: "tool_call", tool: "bash", args: { cmd: "ls" }, tool_id: "t1" },
    ]);
  });

  it("maps tool_execution_end to a tool_result with ok = !isError", () => {
    expect(
      parsePiLine(
        JSON.stringify({
          type: "tool_execution_end",
          toolCallId: "t1",
          isError: false,
          result: { content: [{ type: "text", text: "done" }] },
        }),
      ),
    ).toEqual([{ type: "tool_result", tool_id: "t1", ok: true, result: "done" }]);

    expect(
      parsePiLine(
        JSON.stringify({
          type: "tool_execution_end",
          toolCallId: "t2",
          isError: true,
          result: "boom",
        }),
      ),
    ).toEqual([{ type: "tool_result", tool_id: "t2", ok: false, result: "boom" }]);
  });

  it("maps an assistant message_end to assistant_msg", () => {
    expect(
      parsePiLine(
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "All done." }],
          },
        }),
      ),
    ).toEqual([{ type: "assistant_msg", text: "All done." }]);
  });

  it("maps turn_start to a heartbeat thought", () => {
    expect(parsePiLine(JSON.stringify({ type: "turn_start" }))).toEqual([
      { type: "thought", text: "Calling model…" },
    ]);
  });

  it("drops lifecycle, streaming, and user-role lines", () => {
    expect(parsePiLine(JSON.stringify({ type: "agent_start" }))).toEqual([]);
    expect(parsePiLine(JSON.stringify({ type: "agent_end" }))).toEqual([]);
    expect(parsePiLine(JSON.stringify({ type: "turn_end" }))).toEqual([]);
    expect(parsePiLine(JSON.stringify({ type: "message_start" }))).toEqual([]);
    expect(
      parsePiLine(
        JSON.stringify({
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        }),
      ),
    ).toEqual([]);
  });

  it("tolerates blank lines and non-JSON garbage", () => {
    expect(parsePiLine("")).toEqual([]);
    expect(parsePiLine("   ")).toEqual([]);
    expect(parsePiLine("not json at all")).toEqual([]);
  });
});

describe("summarizeEvent", () => {
  it("stores assistant_msg untruncated so the terminal response is whole", () => {
    const long = "x".repeat(2000);
    expect(summarizeEvent({ type: "assistant_msg", text: long })).toBe(long);
  });

  it("truncates noisy thoughts", () => {
    const long = "y".repeat(2000);
    const out = summarizeEvent({ type: "thought", text: long });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(long.length);
    expect(out).toContain("[truncated]");
  });

  it("formats tool_call as tool(args)", () => {
    expect(
      summarizeEvent({ type: "tool_call", tool: "bash", args: { cmd: "ls" } }),
    ).toBe('bash({"cmd":"ls"})');
  });

  it("returns exit_code for a result event", () => {
    expect(
      summarizeEvent({
        type: "result",
        exit_code: 0,
        duration_ms: 1,
        branch: null,
        pr_url: null,
      }),
    ).toBe("exit_code=0");
  });
});
