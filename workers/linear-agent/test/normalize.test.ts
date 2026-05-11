import { describe, expect, it } from "vitest";

import {
  normalize,
  type LinearWebhookBody,
} from "../src/lib/workflows/normalize";

// Unit tests for the Linear-webhook → EventTuple normalizer. The
// resolver and dispatcher only ever see the output here; covering each
// Linear event shape pins the wire contract.

describe("normalize", () => {
  it("returns null for unknown envelope types", () => {
    expect(normalize({ type: "Unknown", organizationId: "o1" })).toBeNull();
  });

  it("returns null when organizationId is missing", () => {
    expect(
      normalize({ type: "Issue", data: { id: "i1" } } as LinearWebhookBody),
    ).toBeNull();
  });

  it("emits state_entered + state_exited for an Issue update with a state change", () => {
    const out = normalize({
      type: "Issue",
      action: "update",
      organizationId: "o1",
      data: {
        id: "i1",
        identifier: "SYM-1",
        title: "do it",
        teamId: "team-a",
        stateId: "s-todo",
        state: { id: "s-todo", name: "Todo" },
      },
      updatedFrom: { stateId: "s-backlog" },
    });
    expect(out).not.toBeNull();
    expect(out!.length).toBe(2);
    const entered = out!.find((e) => e.event_type === "state_entered")!;
    const exited = out!.find((e) => e.event_type === "state_exited")!;
    expect(entered.event_type).toBe("state_entered");
    expect((entered as { to_state: string }).to_state).toBe("Todo");
    expect(exited.event_type).toBe("state_exited");
  });

  it("emits assignee_changed when updatedFrom.assigneeId differs", () => {
    const out = normalize({
      type: "Issue",
      action: "update",
      organizationId: "o1",
      data: {
        id: "i1",
        teamId: "team-a",
        assignee: { id: "user-new" },
      },
      updatedFrom: { assigneeId: "user-old" },
    });
    expect(out).not.toBeNull();
    const change = out!.find((e) => e.event_type === "assignee_changed");
    expect(change).toBeDefined();
    expect((change as { to_assignee_id: string }).to_assignee_id).toBe("user-new");
    expect((change as { from_assignee_id: string }).from_assignee_id).toBe(
      "user-old",
    );
  });

  it("emits label_added when a new label appears in data.labels", () => {
    const out = normalize({
      type: "Issue",
      action: "update",
      organizationId: "o1",
      data: {
        id: "i1",
        teamId: "team-a",
        labels: [
          { id: "label-blocked", name: "blocked" },
        ],
      },
      updatedFrom: { labelIds: [] },
    });
    expect(out).not.toBeNull();
    const ev = out!.find((e) => e.event_type === "label_added");
    expect(ev).toBeDefined();
    expect((ev as { label_name: string }).label_name).toBe("blocked");
  });

  it("emits label_removed when a label drops out of data.labels", () => {
    const out = normalize({
      type: "Issue",
      action: "update",
      organizationId: "o1",
      data: {
        id: "i1",
        teamId: "team-a",
        labels: [],
      },
      updatedFrom: { labelIds: ["label-blocked"] },
    });
    expect(out).not.toBeNull();
    const ev = out!.find((e) => e.event_type === "label_removed");
    expect(ev).toBeDefined();
    expect((ev as { label_id: string }).label_id).toBe("label-blocked");
  });

  it("emits comment_added on a Comment create", () => {
    const out = normalize({
      type: "Comment",
      action: "create",
      organizationId: "o1",
      data: {
        id: "comment-1",
        body: "/retry please",
        user: { id: "user-1" },
        issue: { id: "i1", identifier: "SYM-1", title: "x", teamId: "team-a" },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.length).toBe(1);
    expect(out![0]!.event_type).toBe("comment_added");
    expect((out![0] as { comment: string }).comment).toBe("/retry please");
  });

  it("emits label_added for an IssueLabel create", () => {
    const out = normalize({
      type: "IssueLabel",
      action: "create",
      organizationId: "o1",
      data: {
        id: "issue-label-1",
        label: { id: "label-x", name: "needs-review" },
        issue: { id: "i1", identifier: "SYM-1", title: "x", teamId: "team-a" },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.length).toBe(1);
    expect(out![0]!.event_type).toBe("label_added");
    expect((out![0] as { label_name: string }).label_name).toBe("needs-review");
  });

  it("emits session_started for an AgentSessionEvent envelope", () => {
    const out = normalize({
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "o1",
      agentSession: {
        id: "session-1",
        issue: { id: "i1", identifier: "SYM-1", title: "x", teamId: "team-a" },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.length).toBe(1);
    expect(out![0]!.event_type).toBe("session_started");
    expect((out![0] as { agent_session_id: string }).agent_session_id).toBe(
      "session-1",
    );
  });

  it("returns null on Issue updates with no semantic change", () => {
    // No state change, no assignee change, no label change.
    const out = normalize({
      type: "Issue",
      action: "update",
      organizationId: "o1",
      data: { id: "i1", teamId: "team-a" },
      updatedFrom: {},
    });
    expect(out).toBeNull();
  });
});
