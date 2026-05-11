// Unit tests for the Liquid prompt renderer (SYM-295).

import { describe, expect, it } from "vitest";

import { renderPrompt } from "../src/lib/workflows/render";
import type { IssueRef } from "../src/schemas/event";

function fakeIssue(overrides: Partial<IssueRef> = {}): IssueRef {
  return {
    id: "issue-1",
    identifier: "SYM-1",
    title: "Add date to README",
    state: "Todo",
    state_id: null,
    team_id: "team-1",
    project_id: null,
    assignee_id: null,
    labels: [],
    parent_issue: null,
    comments: [],
    ...overrides,
  };
}

describe("renderPrompt", () => {
  it("resolves issue.* variables", async () => {
    const out = await renderPrompt(
      "Work on {{ issue.identifier }}: {{ issue.title }} (state={{ issue.state }})",
      { issue: fakeIssue(), attempt: 1 },
    );
    expect(out).toBe("Work on SYM-1: Add date to README (state=Todo)");
  });

  it("exposes attempt, prompt_context, and new_comments", async () => {
    const template = `Attempt {{ attempt }}.
Context: {{ prompt_context }}.
{%- for c in new_comments %}
- {{ c.body }}{%- endfor %}`;
    const out = await renderPrompt(template, {
      issue: fakeIssue(),
      attempt: 3,
      prompt_context: "follow-up",
      new_comments: [
        { id: "c1", body: "ping" },
        { id: "c2", body: "still waiting" },
      ],
    });
    expect(out).toBe(
      "Attempt 3.\nContext: follow-up.\n- ping\n- still waiting",
    );
  });

  it("iterates issue.labels and issue.comments inside the template", async () => {
    const template = `Labels: {{ issue.labels | join: "," }}.
Comments: {{ issue.comments | size }}.`;
    const out = await renderPrompt(template, {
      issue: fakeIssue({
        labels: ["agent", "ready"],
        comments: [
          { id: "c1", body: "hi" },
          { id: "c2", body: "bye" },
        ],
      }),
      attempt: 1,
    });
    expect(out).toBe("Labels: agent,ready.\nComments: 2.");
  });

  it("missing variables render as empty strings instead of throwing", async () => {
    // `issue.parent_issue` is null; accessing .title on it should not
    // throw — strictVariables is off.
    const out = await renderPrompt(
      "parent={{ issue.parent_issue.title }}, ctx={{ prompt_context }}",
      { issue: fakeIssue(), attempt: 1 },
    );
    expect(out).toBe("parent=, ctx=");
  });

  it("merges arbitrary extras into the Liquid scope", async () => {
    const out = await renderPrompt(
      "moved {{ from_state }} → {{ to_state }}",
      {
        issue: fakeIssue(),
        attempt: 1,
        extra: { from_state: "Backlog", to_state: "Todo" },
      },
    );
    expect(out).toBe("moved Backlog → Todo");
  });

  it("renders parent_issue when present", async () => {
    const out = await renderPrompt(
      "parent={{ issue.parent_issue.identifier }}",
      {
        issue: fakeIssue({
          parent_issue: { id: "p1", identifier: "SYM-99", title: "Epic" },
        }),
        attempt: 1,
      },
    );
    expect(out).toBe("parent=SYM-99");
  });
});
