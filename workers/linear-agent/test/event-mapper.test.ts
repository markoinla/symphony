import { describe, expect, it } from "vitest";
import { lastAssistantText, mapToActivity } from "../src/lib/event-mapper";
import type { NormalizedEvent } from "../src/lib/dispatcher";

describe("mapToActivity", () => {
  it("maps thought events to Linear thought activities", () => {
    expect(
      mapToActivity({ type: "thought", text: "looking at this" }),
    ).toEqual({ type: "thought", body: "looking at this" });
  });

  it("truncates long thought text", () => {
    const long = "x".repeat(2000);
    const activity = mapToActivity({ type: "thought", text: long });
    expect(activity?.body?.length).toBeLessThanOrEqual(1001);
    expect(activity?.body?.endsWith("…")).toBe(true);
  });

  it("maps tool_call to an ephemeral action activity with serialized args", () => {
    expect(
      mapToActivity({
        type: "tool_call",
        tool: "read_file",
        args: { path: "README.md" },
      }),
    ).toEqual({
      type: "action",
      action: "read_file",
      parameter: '{"path":"README.md"}',
      ephemeral: true,
    });
  });

  it("drops successful tool_result events (the matching tool_call covers it)", () => {
    expect(
      mapToActivity({
        type: "tool_result",
        tool_id: "call_1",
        ok: true,
        result: "file contents",
      }),
    ).toBeNull();
  });

  it("maps failed tool_result to a non-ephemeral error activity", () => {
    const activity = mapToActivity({
      type: "tool_result",
      tool_id: "call_2",
      ok: false,
      result: "ENOENT",
    });
    expect(activity).toEqual({ type: "error", body: "ENOENT" });
    expect(activity).not.toHaveProperty("ephemeral");
  });

  it("maps error events to non-ephemeral error activities", () => {
    const activity = mapToActivity({ type: "error", message: "engine died" });
    expect(activity).toEqual({ type: "error", body: "engine died" });
    expect(activity).not.toHaveProperty("ephemeral");
  });

  it("leaves thought activities non-ephemeral", () => {
    const activity = mapToActivity({ type: "thought", text: "thinking" });
    expect(activity).toEqual({ type: "thought", body: "thinking" });
    expect(activity).not.toHaveProperty("ephemeral");
  });

  it("drops assistant_msg / turn_end / result (SessionRunner handles them)", () => {
    expect(mapToActivity({ type: "assistant_msg", text: "hi" })).toBeNull();
    expect(
      mapToActivity({ type: "turn_end", turn: 1, reason: "completed" }),
    ).toBeNull();
    expect(
      mapToActivity({
        type: "result",
        exit_code: 0,
        duration_ms: 1000,
        branch: null,
        pr_url: null,
      }),
    ).toBeNull();
  });
});

describe("lastAssistantText", () => {
  it("returns the last assistant_msg text", () => {
    const events: NormalizedEvent[] = [
      { type: "assistant_msg", text: "first" },
      { type: "tool_call", tool: "read_file" },
      { type: "assistant_msg", text: "last" },
    ];
    expect(lastAssistantText(events)).toBe("last");
  });

  it("returns null when there are no assistant_msg events", () => {
    const events: NormalizedEvent[] = [
      { type: "error", message: "boom" },
      {
        type: "result",
        exit_code: 1,
        duration_ms: 100,
        branch: null,
        pr_url: null,
      },
    ];
    expect(lastAssistantText(events)).toBeNull();
  });

  it("skips empty assistant_msg events", () => {
    const events: NormalizedEvent[] = [
      { type: "assistant_msg", text: "real text" },
      { type: "assistant_msg", text: "" },
    ];
    expect(lastAssistantText(events)).toBe("real text");
  });
});
