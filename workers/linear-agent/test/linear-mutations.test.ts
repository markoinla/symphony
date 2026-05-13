import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchTeamStartedState,
  updateAgentSession,
  updateIssue,
} from "../src/lib/linear-mutations";

/**
 * Cover the new GraphQL mutation wrappers used by T3 (status/delegate
 * on session start, dashboard externalUrl, plan checklist) and any
 * other non-activity Linear write the agent needs.
 *
 * The fetch-mocking style matches `test/token-refresh.test.ts` and
 * `test/dispatcher.test.ts` — `vi.fn` over `globalThis.fetch` with
 * `originalFetch` restored in `afterEach`.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Capture {
  calls: Array<{
    url: string;
    body: { query: string; variables: Record<string, unknown> };
    headers: Record<string, string>;
  }>;
}

function mockOK(response: Record<string, unknown>): Capture {
  const cap: Capture = { calls: [] };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    cap.calls.push({
      url,
      body: JSON.parse(String(init?.body ?? "{}")),
      headers,
    });
    return new Response(JSON.stringify({ data: response }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return cap;
}

describe("updateIssue", () => {
  it("only includes stateId in variables.input when provided", async () => {
    const cap = mockOK({ issueUpdate: { success: true } });
    const result = await updateIssue("tok", {
      issueId: "issue-1",
      stateId: "state-1",
    });

    expect(result).toEqual({ success: true });
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]!.body.variables).toEqual({
      id: "issue-1",
      input: { stateId: "state-1" },
    });
    expect(cap.calls[0]!.body.variables.input).not.toHaveProperty("delegateId");
  });

  it("only includes delegateId in variables.input when provided", async () => {
    const cap = mockOK({ issueUpdate: { success: true } });
    await updateIssue("tok", { issueId: "issue-1", delegateId: "user-99" });

    expect(cap.calls[0]!.body.variables).toEqual({
      id: "issue-1",
      input: { delegateId: "user-99" },
    });
  });

  it("includes both keys when both are provided", async () => {
    const cap = mockOK({ issueUpdate: { success: true } });
    await updateIssue("tok", {
      issueId: "issue-1",
      stateId: "state-1",
      delegateId: "user-99",
    });

    expect(cap.calls[0]!.body.variables.input).toEqual({
      stateId: "state-1",
      delegateId: "user-99",
    });
  });

  it("sends an empty input when neither stateId nor delegateId is set", async () => {
    const cap = mockOK({ issueUpdate: { success: true } });
    await updateIssue("tok", { issueId: "issue-1" });

    expect(cap.calls[0]!.body.variables.input).toEqual({});
  });

  it("uses Bearer prefix when token lacks one", async () => {
    const cap = mockOK({ issueUpdate: { success: true } });
    await updateIssue("raw-token", { issueId: "i" });

    expect(cap.calls[0]!.headers.Authorization).toBe("Bearer raw-token");
  });

  it("keeps Bearer prefix when token already has one", async () => {
    const cap = mockOK({ issueUpdate: { success: true } });
    await updateIssue("Bearer existing-token", { issueId: "i" });

    expect(cap.calls[0]!.headers.Authorization).toBe("Bearer existing-token");
  });

  it("surfaces GraphQL errors as a thrown Error", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ errors: [{ message: "invalid state" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as typeof fetch;

    await expect(
      updateIssue("tok", { issueId: "i", stateId: "s" }),
    ).rejects.toThrow(/issueUpdate graphql: invalid state/);
  });

  it("throws a truncated HTTP error on non-2xx", async () => {
    const longBody = "x".repeat(2000);
    globalThis.fetch = vi.fn(async () =>
      new Response(longBody, { status: 500 }),
    ) as typeof fetch;

    await expect(
      updateIssue("tok", { issueId: "i" }),
    ).rejects.toThrow(/issueUpdate http 500/);
  });

  it("retries with refreshed token on 401 when onTokenExpired is provided", async () => {
    const refreshed = vi.fn(async () => "fresh-token");
    let call = 0;
    const seenAuth: string[] = [];
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenAuth.push(headers.Authorization ?? "");
      if (call === 1) return new Response("nope", { status: 401 });
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await updateIssue(
      "stale-token",
      { issueId: "i", stateId: "s" },
      refreshed,
    );

    expect(result).toEqual({ success: true });
    expect(refreshed).toHaveBeenCalledOnce();
    expect(call).toBe(2);
    expect(seenAuth).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
  });

  it("propagates the 401 body when no onTokenExpired is provided", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("unauthorized", { status: 401 }),
    ) as typeof fetch;

    await expect(
      updateIssue("tok", { issueId: "i" }),
    ).rejects.toThrow(/issueUpdate http 401/);
  });
});

describe("fetchTeamStartedState", () => {
  it("returns the started state with the lowest position", async () => {
    const cap = mockOK({
      workflowStates: {
        nodes: [
          { id: "s-3", name: "Working", position: 30, type: "started" },
          { id: "s-1", name: "In Progress", position: 10, type: "started" },
          { id: "s-2", name: "Review", position: 20, type: "started" },
        ],
      },
    });

    const result = await fetchTeamStartedState("tok", "team-1");

    expect(result).toEqual({ id: "s-1", name: "In Progress" });
    expect(cap.calls[0]!.body.variables).toEqual({ teamId: "team-1" });
    expect(cap.calls[0]!.body.query).toContain("workflowStates");
  });

  it("returns null when the team has no started states", async () => {
    mockOK({ workflowStates: { nodes: [] } });
    const result = await fetchTeamStartedState("tok", "team-1");
    expect(result).toBeNull();
  });

  it("returns null when workflowStates is missing entirely", async () => {
    mockOK({});
    const result = await fetchTeamStartedState("tok", "team-1");
    expect(result).toBeNull();
  });

  it("handles a single-node response", async () => {
    mockOK({
      workflowStates: {
        nodes: [{ id: "s-1", name: "In Progress", position: 5, type: "started" }],
      },
    });
    const result = await fetchTeamStartedState("tok", "team-1");
    expect(result).toEqual({ id: "s-1", name: "In Progress" });
  });

  it("retries with refreshed token on 401", async () => {
    const refreshed = vi.fn(async () => "fresh");
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response("nope", { status: 401 });
      return new Response(
        JSON.stringify({
          data: {
            workflowStates: {
              nodes: [
                { id: "s-1", name: "Doing", position: 1, type: "started" },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await fetchTeamStartedState("stale", "team-1", refreshed);
    expect(result).toEqual({ id: "s-1", name: "Doing" });
    expect(refreshed).toHaveBeenCalledOnce();
  });

  it("surfaces GraphQL errors", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ errors: [{ message: "team not found" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as typeof fetch;

    await expect(fetchTeamStartedState("tok", "nope")).rejects.toThrow(
      /workflowStates graphql: team not found/,
    );
  });
});

describe("updateAgentSession", () => {
  it("accepts externalUrls alone", async () => {
    const cap = mockOK({ agentSessionUpdate: { success: true } });
    const result = await updateAgentSession("tok", {
      agentSessionId: "sess-1",
      externalUrls: [{ label: "Open in Symphony", url: "https://x/y" }],
    });

    expect(result).toEqual({ success: true });
    expect(cap.calls[0]!.body.variables).toEqual({
      id: "sess-1",
      input: {
        externalUrls: [{ label: "Open in Symphony", url: "https://x/y" }],
      },
    });
    expect(cap.calls[0]!.body.variables.input).not.toHaveProperty("plan");
  });

  it("accepts plan alone", async () => {
    const cap = mockOK({ agentSessionUpdate: { success: true } });
    await updateAgentSession("tok", {
      agentSessionId: "sess-1",
      plan: [
        { content: "Prep", status: "completed" },
        { content: "Run", status: "inProgress" },
      ],
    });

    expect(cap.calls[0]!.body.variables).toEqual({
      id: "sess-1",
      input: {
        plan: [
          { content: "Prep", status: "completed" },
          { content: "Run", status: "inProgress" },
        ],
      },
    });
    expect(cap.calls[0]!.body.variables.input).not.toHaveProperty(
      "externalUrls",
    );
  });

  it("accepts both externalUrls and plan", async () => {
    const cap = mockOK({ agentSessionUpdate: { success: true } });
    await updateAgentSession("tok", {
      agentSessionId: "sess-1",
      externalUrls: [{ label: "L", url: "u" }],
      plan: [{ content: "Step", status: "pending" }],
    });

    expect(cap.calls[0]!.body.variables.input).toEqual({
      externalUrls: [{ label: "L", url: "u" }],
      plan: [{ content: "Step", status: "pending" }],
    });
  });

  it("accepts neither (no-op input) and still succeeds", async () => {
    const cap = mockOK({ agentSessionUpdate: { success: true } });
    const result = await updateAgentSession("tok", { agentSessionId: "sess-1" });

    expect(result).toEqual({ success: true });
    expect(cap.calls[0]!.body.variables).toEqual({ id: "sess-1", input: {} });
  });

  it("retries with refreshed token on 401", async () => {
    const refreshed = vi.fn(async () => "fresh");
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response("nope", { status: 401 });
      return new Response(
        JSON.stringify({ data: { agentSessionUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await updateAgentSession(
      "stale",
      {
        agentSessionId: "sess-1",
        externalUrls: [{ label: "L", url: "u" }],
      },
      refreshed,
    );

    expect(result).toEqual({ success: true });
    expect(refreshed).toHaveBeenCalledOnce();
  });

  it("surfaces GraphQL errors", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ errors: [{ message: "bad plan status" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as typeof fetch;

    await expect(
      updateAgentSession("tok", {
        agentSessionId: "s",
        plan: [{ content: "x", status: "pending" }],
      }),
    ).rejects.toThrow(/agentSessionUpdate graphql: bad plan status/);
  });

  it("throws truncated HTTP error on non-2xx", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("nope", { status: 503 }),
    ) as typeof fetch;

    await expect(
      updateAgentSession("tok", { agentSessionId: "s" }),
    ).rejects.toThrow(/agentSessionUpdate http 503/);
  });
});
