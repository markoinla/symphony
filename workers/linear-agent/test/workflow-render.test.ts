// Unit tests for the Liquid prompt renderer (SYM-295).

import { describe, expect, it } from "vitest";

import { renderPrompt } from "../src/lib/workflows/render";
import type { IssueRef, SubjectRef } from "../src/schemas/event";

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
    attachments: [],
    ...overrides,
  };
}

function linearSubject(overrides: Partial<IssueRef> = {}): SubjectRef {
  const issue = fakeIssue(overrides);
  return { ...issue, attachments: issue.attachments ?? [], kind: "linear_issue" } as SubjectRef;
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

  it("resolves subject and context for every SubjectRef kind", async () => {
    const subjects: SubjectRef[] = [
      linearSubject({ title: "Linear title" }),
      {
        kind: "github_issue",
        id: "ghi-1",
        repo: "acme/widgets",
        number: 7,
        title: "GitHub issue title",
        body: "GitHub body",
        state: "open",
        labels: ["bug"],
        author: "octocat",
        assignees: ["octocat"],
      },
      {
        kind: "github_pr",
        id: "pr-1",
        repo: "acme/widgets",
        number: 42,
        title: "PR title",
        body: "PR body",
        state: "open",
        base: "main",
        head: "feature",
        draft: false,
        labels: [],
        author: "octocat",
        reviewers: [],
        head_sha: "abc123",
      },
      {
        kind: "sentry_event",
        id: "evt-1",
        title: "Sentry title",
        message: "boom",
        payload: { issue: "SENTRY-1" },
      },
      {
        kind: "generic",
        external_id: "nightly",
        title: "Generic title",
        payload: { action: "run" },
      },
    ];

    for (const subject of subjects) {
      const out = await renderPrompt(
        "{{ subject.kind }}|{{ subject.title }}|{{ context | json }}",
        {
          issue: fakeIssue(),
          subject,
          attempt: 1,
          context: { nested: { ok: true }, chars: 'quote " and slash \\' },
        },
      );
      expect(out).toContain(`${subject.kind}|${subject.title ?? ""}|`);
      expect(out).toContain('"nested":{"ok":true}');
      expect(out).toContain('"chars":"quote \\" and slash \\\\"');
    }
  });

  it("maps issue sugar for Linear and GitHub issues with source-specific empty fallbacks", async () => {
    const linear = await renderPrompt(
      "{{ issue.title }}|{{ issue.description }}|{{ issue.labels | join: ',' }}|parent={{ issue.parent_issue.identifier }}|assignees={{ issue.assignees | join: ',' }}",
      {
        issue: fakeIssue({
          title: "Linear",
          description: "Linear body",
          labels: ["one"],
          parent_issue: { id: "p1", identifier: "SYM-9", title: "Parent" },
        }),
        subject: linearSubject({
          title: "Linear",
          description: "Linear body",
          labels: ["one"],
          parent_issue: { id: "p1", identifier: "SYM-9", title: "Parent" },
        }),
        attempt: 1,
      },
    );
    expect(linear).toBe("Linear|Linear body|one|parent=SYM-9|assignees=");

    const github = await renderPrompt(
      "{{ issue.title }}|{{ issue.description }}|{{ issue.labels | join: ',' }}|parent={{ issue.parent_issue.identifier }}|assignees={{ issue.assignees | join: ',' }}",
      {
        issue: fakeIssue(),
        subject: {
          kind: "github_issue",
          id: "ghi-1",
          repo: "acme/widgets",
          number: 7,
          title: "GitHub",
          body: "GitHub body",
          state: "open",
          labels: ["two"],
          author: "octocat",
          assignees: ["octocat"],
        },
        attempt: 1,
      },
    );
    expect(github).toBe("GitHub|GitHub body|two|parent=|assignees=octocat");
  });

  it("returns empty strings for sugar accessors when the kind does not match", async () => {
    const cases: Array<{ subject: SubjectRef; template: string }> = [
      {
        subject: {
          kind: "github_pr",
          id: "pr-1",
          repo: "acme/widgets",
          number: 42,
          title: "PR",
          body: "PR body",
          state: "open",
          base: "main",
          head: "feature",
          draft: false,
          labels: [],
          author: "octocat",
          reviewers: [],
          head_sha: "abc123",
        },
        template: "issue={{ issue.title }} event={{ event.title }} payload={{ payload.action }}",
      },
      {
        subject: { kind: "sentry_event", id: "evt-1", title: "Event", payload: {} },
        template: "issue={{ issue.title }} pr={{ pr.title }} payload={{ payload.action }}",
      },
      {
        subject: { kind: "generic", external_id: "gen", payload: { action: "run" } },
        template: "issue={{ issue.title }} pr={{ pr.title }} event={{ event.title }}",
      },
    ];

    for (const { subject, template } of cases) {
      const out = await renderPrompt(template, {
        issue: fakeIssue(),
        subject,
        attempt: 1,
      });
      expect(out).not.toContain("PR");
      expect(out).not.toContain("Event");
      expect(out).not.toContain("run");
      expect(out).toMatch(/=$|= /);
    }
  });

  it("resolves matching pr, event, and payload sugar values", async () => {
    await expect(
      renderPrompt("{{ pr.title }} on {{ pr.branch }}", {
        issue: fakeIssue(),
        subject: {
          kind: "github_pr",
          id: "pr-1",
          repo: "acme/widgets",
          number: 42,
          title: "Fix",
          body: "PR body",
          state: "open",
          base: "main",
          head: "bugfix",
          branch: "bugfix",
          draft: false,
          labels: [],
          author: "octocat",
          reviewers: [],
          head_sha: "abc123",
        },
        attempt: 1,
      }),
    ).resolves.toBe("Fix on bugfix");

    await expect(
      renderPrompt("{{ event.title }} at {{ event.culprit }}", {
        issue: fakeIssue(),
        subject: { kind: "sentry_event", id: "evt-1", title: "Boom", culprit: "app.run", payload: {} },
        attempt: 1,
      }),
    ).resolves.toBe("Boom at app.run");

    await expect(
      renderPrompt("{{ payload.action }}", {
        issue: fakeIssue(),
        subject: { kind: "generic", external_id: "gen", payload: { action: "run" } },
        attempt: 1,
      }),
    ).resolves.toBe("run");
  });
});
