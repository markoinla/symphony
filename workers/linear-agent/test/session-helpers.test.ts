import { describe, expect, it } from "vitest";

import { resolvePrompt } from "../src/lib/session-helpers";
import type { AgentSessionEventWebhook } from "../src/types/agent-session";

/**
 * Coverage for the T3 additions to `resolvePrompt` — namely the
 * `Prior comments:` block fed from `event.previousComments`. The
 * existing base/guidance behavior is implicitly covered by every
 * case below (every test expects the original prompt to land
 * unchanged when there's nothing to prepend).
 */

const baseEvent = (
  overrides: Partial<AgentSessionEventWebhook> = {},
): AgentSessionEventWebhook => ({
  type: "AgentSessionEvent",
  action: "created",
  webhookId: "wh-1",
  agentSession: {
    id: "session-1",
    issue: { id: "i", identifier: "SYM-1", title: "Test issue" },
  },
  promptContext: "Do the thing",
  ...overrides,
});

describe("resolvePrompt — previousComments", () => {
  it("returns the bare prompt when previousComments is absent", () => {
    const out = resolvePrompt(baseEvent());
    expect(out).toBe("Do the thing");
  });

  it("returns the bare prompt when previousComments is an empty array", () => {
    const out = resolvePrompt(baseEvent({ previousComments: [] }));
    expect(out).toBe("Do the thing");
  });

  it("prepends a Prior comments: block before the prompt", () => {
    const out = resolvePrompt(
      baseEvent({
        previousComments: [
          { id: "c1", body: "first comment", userId: "u1" },
          { id: "c2", body: "second comment", userId: "u2" },
        ],
      }),
    );
    // Order: prior block, blank line + separator, original prompt.
    expect(out).toBe(
      [
        "Prior comments:",
        "- (userId: u1) first comment",
        "- (userId: u2) second comment",
        "",
        "---",
        "",
        "Do the thing",
      ].join("\n"),
    );
  });

  it("omits the userId prefix when missing", () => {
    const out = resolvePrompt(
      baseEvent({
        previousComments: [{ id: "c1", body: "anon" }],
      }),
    );
    expect(out).toContain("- anon");
    expect(out).not.toContain("(userId:");
  });

  it("truncates long comment bodies to ~500 chars with the suffix", () => {
    const longBody = "x".repeat(2000);
    const out = resolvePrompt(
      baseEvent({
        previousComments: [{ id: "c1", body: longBody, userId: "u1" }],
      }),
    );
    expect(out).toContain("[truncated]");
    // The truncated body itself is 500 chars; with userId prefix the
    // bullet line still fits well under the original 2000-char body.
    const bulletLine = out!
      .split("\n")
      .find((l) => l.startsWith("- (userId: u1)"));
    expect(bulletLine).toBeDefined();
    expect(bulletLine!.length).toBeLessThan(700);
  });

  it("keeps only the most recent 10 comments", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: `c${i}`,
      body: `comment ${i}`,
      userId: `u${i}`,
    }));
    const out = resolvePrompt(baseEvent({ previousComments: many }));
    // We slice the tail — comments 0..4 should be gone, 5..14 kept.
    expect(out).not.toContain("comment 4");
    expect(out).toContain("comment 5");
    expect(out).toContain("comment 14");
    // Sanity: exactly 10 bullet lines.
    const bulletCount = (out!.match(/^- /gm) ?? []).length;
    expect(bulletCount).toBe(10);
  });

  it("skips comments with empty/missing body", () => {
    const out = resolvePrompt(
      baseEvent({
        previousComments: [
          { id: "c1", body: "", userId: "u1" },
          // @ts-expect-error — exercise the runtime guard against
          // an undefined body slipping through.
          { id: "c2" },
          { id: "c3", body: "real one", userId: "u3" },
        ],
      }),
    );
    expect(out).toContain("- (userId: u3) real one");
    expect(out).not.toContain("u1");
    expect(out).not.toContain("c2");
  });

  it("returns null when there's no prompt source at all", () => {
    const out = resolvePrompt({
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-empty",
      agentSession: { id: "s1" },
      previousComments: [{ id: "c1", body: "x" }],
    } as AgentSessionEventWebhook);
    // No base prompt → null even though previousComments is non-empty.
    expect(out).toBeNull();
  });

  it("preserves the prior-comments → guidance ordering when both apply", () => {
    const out = resolvePrompt(
      baseEvent({
        previousComments: [{ id: "c1", body: "earlier" }],
        guidance: "use the lint task",
      }),
    );
    expect(out).toBe(
      [
        "Prior comments:",
        "- earlier",
        "",
        "---",
        "",
        "Do the thing",
        "",
        "---",
        "Guidance:",
        "use the lint task",
      ].join("\n"),
    );
  });

  it("strips @bot tokens from comment bodies", () => {
    const out = resolvePrompt(
      baseEvent({
        previousComments: [
          { id: "c1", body: "@symphony-bot please check this", userId: "u1" },
        ],
      }),
    );
    expect(out).not.toContain("@symphony-bot");
    expect(out).toContain("please check this");
  });
});
