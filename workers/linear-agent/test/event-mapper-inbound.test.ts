import { describe, expect, it } from "vitest";

import {
  mapIssueEnvelopeToEvents,
  type IssueWebhookEnvelope,
  type MapResult,
} from "../src/lib/event-mapper-inbound";

const ORG = "org-1";

function envelope(
  partial: Partial<IssueWebhookEnvelope> & {
    action: IssueWebhookEnvelope["action"];
  },
): IssueWebhookEnvelope {
  return {
    type: "Issue",
    organizationId: "linear-org-1",
    webhookId: "wh-1",
    webhookTimestamp: 1700000000,
    ...partial,
  };
}

function at(out: MapResult[], i: number): MapResult {
  const r = out[i];
  if (!r) throw new Error(`expected an event at index ${i}, got ${out.length}`);
  return r;
}

describe("mapIssueEnvelopeToEvents — state transitions", () => {
  it("emits state_entered on create", () => {
    const out = mapIssueEnvelopeToEvents(
      envelope({
        action: "create",
        data: {
          id: "i1",
          identifier: "SYM-1",
          teamId: "t1",
          stateId: "s-new",
          state: { id: "s-new", name: "Todo" },
        },
      }),
      ORG,
    );
    expect(out).toHaveLength(1);
    const e = at(out, 0).event;
    if (e.event_type !== "state_entered") throw new Error("type");
    expect(e.to_state).toBe("Todo");
    expect(e.from_state).toBeNull();
  });

  it("emits state_exited + state_entered on a real state change", () => {
    const out = mapIssueEnvelopeToEvents(
      envelope({
        action: "update",
        data: {
          id: "i1",
          identifier: "SYM-1",
          teamId: "t1",
          stateId: "s-new",
          state: { id: "s-new", name: "In Progress" },
        },
        updatedFrom: {
          stateId: "s-old",
          state: { id: "s-old", name: "Todo" },
        },
      }),
      ORG,
    );
    expect(out.map((r) => r.event.event_type)).toEqual([
      "state_exited",
      "state_entered",
    ]);
    const exited = at(out, 0).event;
    if (exited.event_type !== "state_exited") throw new Error("type");
    expect(exited.from_state).toBe("Todo");
    expect(exited.to_state).toBe("In Progress");
    const entered = at(out, 1).event;
    if (entered.event_type !== "state_entered") throw new Error("type");
    expect(entered.to_state).toBe("In Progress");
    expect(entered.from_state).toBe("Todo");
  });

  it("emits nothing when stateId didn't actually change", () => {
    const out = mapIssueEnvelopeToEvents(
      envelope({
        action: "update",
        data: {
          id: "i1",
          stateId: "s-same",
          state: { id: "s-same", name: "Todo" },
        },
        updatedFrom: { stateId: "s-same" },
      }),
      ORG,
    );
    expect(out).toEqual([]);
  });

  it("emits nothing when only an unrelated field changed (e.g. title)", () => {
    const out = mapIssueEnvelopeToEvents(
      envelope({
        action: "update",
        data: {
          id: "i1",
          stateId: "s1",
          state: { id: "s1", name: "Todo" },
          title: "new title",
        },
        updatedFrom: { title: "old title" },
      }),
      ORG,
    );
    expect(out).toEqual([]);
  });
});

describe("mapIssueEnvelopeToEvents — label changes", () => {
  it("emits label_added for each label newly present", () => {
    const out = mapIssueEnvelopeToEvents(
      envelope({
        action: "update",
        data: {
          id: "i1",
          identifier: "SYM-1",
          stateId: "s1",
          state: { id: "s1", name: "Todo" },
          labels: [
            { id: "l-old", name: "bug" },
            { id: "l-new1", name: "blocked" },
            { id: "l-new2", name: "p0" },
          ],
        },
        updatedFrom: { labelIds: ["l-old"] },
      }),
      ORG,
    );

    const added = out.filter((r) => r.event.event_type === "label_added");
    const names = added
      .map((r) =>
        r.event.event_type === "label_added" ? r.event.label_name : null,
      )
      .filter(Boolean)
      .sort();
    expect(names).toEqual(["blocked", "p0"]);
  });

  it("does not emit any event when a label is dropped (label_removed unsupported)", () => {
    const out = mapIssueEnvelopeToEvents(
      envelope({
        action: "update",
        data: {
          id: "i1",
          stateId: "s1",
          state: { id: "s1", name: "Todo" },
          labels: [{ id: "l-keep", name: "bug" }],
        },
        updatedFrom: { labelIds: ["l-keep", "l-removed"] },
      }),
      ORG,
    );
    expect(out).toEqual([]);
  });

  it("doesn't emit label events when labelIds is absent from updatedFrom", () => {
    const out = mapIssueEnvelopeToEvents(
      envelope({
        action: "update",
        data: {
          id: "i1",
          stateId: "s-new",
          state: { id: "s-new", name: "Todo" },
          labels: [{ id: "l1", name: "bug" }],
        },
        updatedFrom: { stateId: "s-old", state: { name: "Backlog" } },
      }),
      ORG,
    );
    expect(out.some((r) => r.event.event_type.startsWith("label_"))).toBe(false);
  });
});

describe("mapIssueEnvelopeToEvents — assignee change", () => {
  it("emits assignee_changed with both sides", () => {
    const out = mapIssueEnvelopeToEvents(
      envelope({
        action: "update",
        data: {
          id: "i1",
          stateId: "s1",
          state: { id: "s1", name: "Todo" },
          assigneeId: "u-new",
        },
        updatedFrom: { assigneeId: "u-old" },
      }),
      ORG,
    );
    expect(out).toHaveLength(1);
    const e = at(out, 0).event;
    if (e.event_type !== "assignee_changed") throw new Error("type");
    expect(e.from_assignee_id).toBe("u-old");
    expect(e.to_assignee_id).toBe("u-new");
    expect(e.assignee_id).toBe("u-new");
  });

  it("handles unassigning (assigneeId went to null)", () => {
    const out = mapIssueEnvelopeToEvents(
      envelope({
        action: "update",
        data: { id: "i1", stateId: "s1", state: { name: "Todo" } },
        updatedFrom: { assigneeId: "u-prev" },
      }),
      ORG,
    );
    const e = at(out, 0).event;
    if (e.event_type !== "assignee_changed") throw new Error("type");
    expect(e.from_assignee_id).toBe("u-prev");
    expect(e.to_assignee_id).toBeNull();
  });
});

describe("mapIssueEnvelopeToEvents — combined deliveries", () => {
  it("emits state + label events in one delivery", () => {
    const out = mapIssueEnvelopeToEvents(
      envelope({
        action: "update",
        data: {
          id: "i1",
          identifier: "SYM-1",
          stateId: "s-new",
          state: { id: "s-new", name: "In Progress" },
          labels: [{ id: "l1", name: "p0" }],
        },
        updatedFrom: {
          stateId: "s-old",
          state: { id: "s-old", name: "Todo" },
          labelIds: [],
        },
      }),
      ORG,
    );
    const types = out.map((r) => r.event.event_type);
    expect(types).toContain("state_entered");
    expect(types).toContain("state_exited");
    expect(types).toContain("label_added");
  });
});
