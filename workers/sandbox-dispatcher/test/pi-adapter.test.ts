import { describe, expect, it } from "vitest";
import { piEngineAdapter } from "../src/engines/pi";

/**
 * Pi adapter unit tests. The fixtures here are the same ones we
 * already ship in `workers/linear-agent/test/webhook.test.ts` — when
 * pi's event schema changes, both worker test suites should break
 * together.
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

  it("drops lifecycle events", () => {
    expect(piEngineAdapter.parseEvents('{"type":"session","id":"x"}')).toEqual(
      [],
    );
    expect(piEngineAdapter.parseEvents('{"type":"agent_start"}')).toEqual([]);
    expect(piEngineAdapter.parseEvents('{"type":"turn_start"}')).toEqual([]);
    expect(piEngineAdapter.parseEvents('{"type":"agent_end"}')).toEqual([]);
  });

  it("drops text_delta updates (consolidated by message_end)", () => {
    const line =
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hi"}}';
    expect(piEngineAdapter.parseEvents(line)).toEqual([]);
  });

  it("tolerates blank lines and non-JSON", () => {
    expect(piEngineAdapter.parseEvents("")).toEqual([]);
    expect(piEngineAdapter.parseEvents("   ")).toEqual([]);
    expect(piEngineAdapter.parseEvents("not json")).toEqual([]);
  });
});
