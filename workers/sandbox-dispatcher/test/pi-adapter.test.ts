import { describe, expect, it } from "vitest";
import { piEngineAdapter } from "../src/engines/pi";

/**
 * Pi adapter unit tests. The fixtures here are recorded from real
 * `pi --print --mode json` runs (see docs/json.md and the
 * @mariozechner/pi-ai types). When pi's event schema changes, both
 * worker test suites should break together.
 */
describe("piEngineAdapter.parseEvents", () => {
  it("turns assistant message_end into an assistant_msg event", () => {
    const line =
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done — opened PR."}]}}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([
      { type: "assistant_msg", text: "Done — opened PR." },
    ]);
  });

  it("concatenates multiple text content blocks", () => {
    const line =
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"part 1 "},{"type":"text","text":"part 2"}]}}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([
      { type: "assistant_msg", text: "part 1 part 2" },
    ]);
  });

  it("drops user-role message_end", () => {
    const line =
      '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"prompt"}]}}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([]);
  });

  it("drops empty assistant text", () => {
    const line =
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":""}]}}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([]);
  });

  it("drops a message_end whose only content is a toolCall", () => {
    // Pi emits one of these alongside the tool_execution_start. The
    // tool call itself is surfaced via tool_execution_start; this
    // message_end carries no text and should not double-post.
    const line =
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"ls"}}]}}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([]);
  });

  it("drops lifecycle events", () => {
    expect(piEngineAdapter.parseEvents('{"type":"session","id":"x"}')).toEqual(
      [],
    );
    expect(piEngineAdapter.parseEvents('{"type":"agent_start"}')).toEqual([]);
    expect(piEngineAdapter.parseEvents('{"type":"agent_end"}')).toEqual([]);
    expect(piEngineAdapter.parseEvents('{"type":"turn_end"}')).toEqual([]);
    expect(
      piEngineAdapter.parseEvents('{"type":"message_start","message":{}}'),
    ).toEqual([]);
  });

  it("turns turn_start into a thought heartbeat", () => {
    expect(piEngineAdapter.parseEvents('{"type":"turn_start"}')).toEqual([
      { type: "thought", text: "Calling model…" },
    ]);
  });

  it("drops text_delta updates (consolidated by message_end)", () => {
    const line =
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hi"}}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([]);
  });

  it("drops toolcall_* update events (covered by tool_execution_start)", () => {
    expect(
      piEngineAdapter.parseEvents(
        '{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":0}}',
      ),
    ).toEqual([]);
    expect(
      piEngineAdapter.parseEvents(
        '{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","delta":"{\\"cmd"}}',
      ),
    ).toEqual([]);
    expect(
      piEngineAdapter.parseEvents(
        '{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":0}}',
      ),
    ).toEqual([]);
  });

  it("drops tool_execution_update partials", () => {
    const line =
      '{"type":"tool_execution_update","toolCallId":"call_1","toolName":"bash","args":{},"partialResult":{"stdout":"in flight"}}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([]);
  });

  it("turns tool_execution_start into a tool_call event", () => {
    const line =
      '{"type":"tool_execution_start","toolCallId":"call_xyz","toolName":"bash","args":{"command":"ls -la"}}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([
      {
        type: "tool_call",
        tool: "bash",
        args: { command: "ls -la" },
        tool_id: "call_xyz",
      },
    ]);
  });

  it("drops tool_execution_start with no toolName", () => {
    const line = '{"type":"tool_execution_start","toolCallId":"call_1"}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([]);
  });

  it("turns successful tool_execution_end into a tool_result event", () => {
    const line =
      '{"type":"tool_execution_end","toolCallId":"call_xyz","toolName":"bash","result":{"content":[{"type":"text","text":"4\\n"}]},"isError":false}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([
      {
        type: "tool_result",
        tool_id: "call_xyz",
        ok: true,
        result: "4\n",
      },
    ]);
  });

  it("turns failed tool_execution_end into an ok=false tool_result", () => {
    const line =
      '{"type":"tool_execution_end","toolCallId":"call_xyz","toolName":"bash","result":{"content":[{"type":"text","text":"command not found: foo"}]},"isError":true}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([
      {
        type: "tool_result",
        tool_id: "call_xyz",
        ok: false,
        result: "command not found: foo",
      },
    ]);
  });

  it("handles tool_execution_end where result is a bare string", () => {
    const line =
      '{"type":"tool_execution_end","toolCallId":"call_xyz","toolName":"bash","result":"raw string output","isError":false}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([
      {
        type: "tool_result",
        tool_id: "call_xyz",
        ok: true,
        result: "raw string output",
      },
    ]);
  });

  it("handles tool_execution_end with null result", () => {
    const line =
      '{"type":"tool_execution_end","toolCallId":"call_xyz","toolName":"bash","result":null,"isError":false}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([
      {
        type: "tool_result",
        tool_id: "call_xyz",
        ok: true,
        result: "",
      },
    ]);
  });

  it("turns thinking_end into a thought event with the consolidated content", () => {
    const line =
      '{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0,"content":"Need to multiply 17 by 23. 17*20=340, 17*3=51, total 391."}}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([
      {
        type: "thought",
        text:
          "Need to multiply 17 by 23. 17*20=340, 17*3=51, total 391.",
      },
    ]);
  });

  it("drops thinking_start and thinking_delta (consolidated by thinking_end)", () => {
    expect(
      piEngineAdapter.parseEvents(
        '{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}',
      ),
    ).toEqual([]);
    expect(
      piEngineAdapter.parseEvents(
        '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"Need to "}}',
      ),
    ).toEqual([]);
  });

  it("drops empty thinking_end", () => {
    const line =
      '{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0,"content":""}}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([]);
  });

  it("tolerates blank lines and non-JSON", () => {
    expect(piEngineAdapter.parseEvents("")).toEqual([]);
    expect(piEngineAdapter.parseEvents("   ")).toEqual([]);
    expect(piEngineAdapter.parseEvents("not json")).toEqual([]);
  });
});
