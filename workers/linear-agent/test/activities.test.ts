import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildActivityClient,
  postAction,
  postElicitation,
  postError,
  postResponse,
  postThought,
} from "../src/lib/activities";

/**
 * Activity wrappers: verify the GraphQL `content` payload shape for
 * each helper, with particular attention to the `ephemeral` opt-in on
 * `postThought` / `postAction` introduced for Linear agent best
 * practices. Other activity types must NOT carry `ephemeral`.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchCapture(): { calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), headers });
    return new Response(
      JSON.stringify({ data: { agentActivityCreate: { success: true } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { calls };
}

describe("postThought", () => {
  it("omits ephemeral when opts is not provided", async () => {
    const { calls } = mockFetchCapture();
    const client = buildActivityClient("test-token");
    await postThought(client, "session-1", "thinking…");

    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as { variables: { input: { content: Record<string, unknown> } } };
    expect(body.variables.input).toEqual({
      agentSessionId: "session-1",
      content: { type: "thought", body: "thinking…" },
    });
    expect(body.variables.input.content).not.toHaveProperty("ephemeral");
  });

  it("passes ephemeral=true into content when opts.ephemeral is true", async () => {
    const { calls } = mockFetchCapture();
    const client = buildActivityClient("test-token");
    await postThought(client, "session-1", "scratchpad", { ephemeral: true });

    const body = calls[0]!.body as { variables: { input: { content: Record<string, unknown> } } };
    expect(body.variables.input.content).toEqual({
      type: "thought",
      body: "scratchpad",
      ephemeral: true,
    });
  });

  it("passes ephemeral=false explicitly through when set", async () => {
    const { calls } = mockFetchCapture();
    const client = buildActivityClient("test-token");
    await postThought(client, "session-1", "keep me", { ephemeral: false });

    const body = calls[0]!.body as { variables: { input: { content: Record<string, unknown> } } };
    expect(body.variables.input.content).toEqual({
      type: "thought",
      body: "keep me",
      ephemeral: false,
    });
  });
});

describe("postAction", () => {
  it("omits ephemeral and result when not provided", async () => {
    const { calls } = mockFetchCapture();
    const client = buildActivityClient("test-token");
    await postAction(client, "session-1", "bash", "ls -la");

    const body = calls[0]!.body as { variables: { input: { content: Record<string, unknown> } } };
    expect(body.variables.input.content).toEqual({
      type: "action",
      action: "bash",
      parameter: "ls -la",
    });
  });

  it("passes ephemeral=true into content when opts.ephemeral is true", async () => {
    const { calls } = mockFetchCapture();
    const client = buildActivityClient("test-token");
    await postAction(client, "session-1", "bash", "ls", undefined, {
      ephemeral: true,
    });

    const body = calls[0]!.body as { variables: { input: { content: Record<string, unknown> } } };
    expect(body.variables.input.content).toEqual({
      type: "action",
      action: "bash",
      parameter: "ls",
      ephemeral: true,
    });
  });

  it("carries both result and ephemeral when both supplied", async () => {
    const { calls } = mockFetchCapture();
    const client = buildActivityClient("test-token");
    await postAction(client, "session-1", "bash", "ls", "file1\nfile2", {
      ephemeral: true,
    });

    const body = calls[0]!.body as { variables: { input: { content: Record<string, unknown> } } };
    expect(body.variables.input.content).toEqual({
      type: "action",
      action: "bash",
      parameter: "ls",
      result: "file1\nfile2",
      ephemeral: true,
    });
  });
});

describe("non-ephemeral helpers", () => {
  it("postResponse does not carry ephemeral", async () => {
    const { calls } = mockFetchCapture();
    const client = buildActivityClient("test-token");
    await postResponse(client, "session-1", "final answer");

    const body = calls[0]!.body as { variables: { input: { content: Record<string, unknown> } } };
    expect(body.variables.input.content).toEqual({
      type: "response",
      body: "final answer",
    });
    expect(body.variables.input.content).not.toHaveProperty("ephemeral");
  });

  it("postError does not carry ephemeral", async () => {
    const { calls } = mockFetchCapture();
    const client = buildActivityClient("test-token");
    await postError(client, "session-1", "boom");

    const body = calls[0]!.body as { variables: { input: { content: Record<string, unknown> } } };
    expect(body.variables.input.content).not.toHaveProperty("ephemeral");
  });

  it("postElicitation does not carry ephemeral", async () => {
    const { calls } = mockFetchCapture();
    const client = buildActivityClient("test-token");
    await postElicitation(client, "session-1", "need input");

    const body = calls[0]!.body as { variables: { input: { content: Record<string, unknown> } } };
    expect(body.variables.input.content).not.toHaveProperty("ephemeral");
  });
});
