import { afterEach, describe, expect, it, vi } from "vitest";
import { getIssueState, transitionIssue } from "../src/lib/issues";

afterEach(() => {
  vi.restoreAllMocks();
});

interface MockCall {
  query: string;
  variables: Record<string, unknown>;
  body: unknown;
}

/**
 * Records each Linear GraphQL POST and returns the canned response
 * for the operation found in the query (matched by mutation/query
 * name). Tests that want to assert ordering inspect `calls`.
 */
function installLinearMock(responseByOperation: Record<string, unknown>): {
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const body = JSON.parse(init?.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push({ query: body.query, variables: body.variables, body });

    const op = Object.keys(responseByOperation).find((k) =>
      body.query.includes(k),
    );
    if (!op) {
      throw new Error(`unmocked Linear operation: ${body.query.slice(0, 80)}`);
    }
    return new Response(
      JSON.stringify({ data: responseByOperation[op] }),
      { status: 200 },
    );
  });
  return { calls };
}

describe("getIssueState", () => {
  it("returns the current state name when the issue exists", async () => {
    installLinearMock({
      GetIssueState: {
        issue: {
          id: "issue-1",
          identifier: "SYM-1",
          state: { name: "Todo" },
        },
      },
    });
    const result = await getIssueState("tok", "issue-1");
    expect(result).toEqual({
      id: "issue-1",
      identifier: "SYM-1",
      state: { name: "Todo" },
    });
  });

  it("returns null when the issue is not found", async () => {
    installLinearMock({ GetIssueState: { issue: null } });
    const result = await getIssueState("tok", "missing");
    expect(result).toBeNull();
  });
});

describe("transitionIssue", () => {
  it("transitions Todo → In Progress in two queries + one mutation", async () => {
    const { calls } = installLinearMock({
      GetIssueState: {
        issue: { id: "issue-1", identifier: "SYM-1", state: { name: "Todo" } },
      },
      ResolveStateId: {
        issue: {
          team: { states: { nodes: [{ id: "state-uuid-in-progress" }] } },
        },
      },
      UpdateIssueState: { issueUpdate: { success: true } },
    });

    const result = await transitionIssue("tok", "issue-1", "In Progress");
    expect(result).toEqual({ from: "Todo", to: "In Progress" });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.query).toContain("GetIssueState");
    expect(calls[1]?.query).toContain("ResolveStateId");
    expect(calls[1]?.variables).toEqual({
      issueId: "issue-1",
      stateName: "In Progress",
    });
    expect(calls[2]?.query).toContain("UpdateIssueState");
    expect(calls[2]?.variables).toEqual({
      issueId: "issue-1",
      stateId: "state-uuid-in-progress",
    });
  });

  it("no-ops when the issue is already in the target state", async () => {
    const { calls } = installLinearMock({
      GetIssueState: {
        issue: {
          id: "issue-1",
          identifier: "SYM-1",
          state: { name: "Human Review" },
        },
      },
    });

    const result = await transitionIssue("tok", "issue-1", "Human Review");
    expect(result).toBeNull();
    // Only the snapshot query — no resolve, no mutate.
    expect(calls).toHaveLength(1);
  });

  it("returns null and logs when the target state is unknown on the team", async () => {
    const { calls } = installLinearMock({
      GetIssueState: {
        issue: { id: "issue-1", identifier: "SYM-1", state: { name: "Todo" } },
      },
      ResolveStateId: {
        issue: { team: { states: { nodes: [] } } },
      },
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await transitionIssue("tok", "issue-1", "NoSuchState");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalledWith(
      "transition_state_unknown",
      expect.stringContaining("NoSuchState"),
    );
  });

  it("throws when the issueUpdate mutation reports failure", async () => {
    installLinearMock({
      GetIssueState: {
        issue: { id: "issue-1", identifier: "SYM-1", state: { name: "Todo" } },
      },
      ResolveStateId: {
        issue: { team: { states: { nodes: [{ id: "state-uuid" }] } } },
      },
      UpdateIssueState: { issueUpdate: { success: false } },
    });

    await expect(
      transitionIssue("tok", "issue-1", "In Progress"),
    ).rejects.toThrow(/transition_failed/);
  });
});
