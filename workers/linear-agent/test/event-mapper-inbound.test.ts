import { describe, expect, it } from "vitest";
import {
  isIssueEnvelope,
  mapIssueUpdateToEvent,
  type IssueWebhookEnvelope,
} from "../src/lib/event-mapper-inbound";

const orgId = "org-1";

function envelope(overrides: Partial<IssueWebhookEnvelope> = {}): IssueWebhookEnvelope {
  return {
    type: "Issue",
    action: "update",
    updatedFrom: { stateId: "state-old", state: { name: "Todo" } },
    data: {
      id: "issue-1",
      identifier: "SYM-1",
      title: "Test issue",
      description: "Body",
      stateId: "state-new",
      teamId: "team-1",
      projectId: "project-1",
      assigneeId: "user-1",
      state: { id: "state-new", name: "In Progress" },
      labels: [{ name: "bug" }, { id: "label-without-name" }, { name: "" }],
    },
    ...overrides,
  };
}

describe("mapIssueUpdateToEvent", () => {
  it("maps state transition updates into resolver event tuples", () => {
    const result = mapIssueUpdateToEvent(envelope(), orgId);

    expect(result?.summary).toBe("SYM-1 Todo → In Progress");
    expect(result?.fromStateName).toBe("Todo");
    expect(result?.event).toMatchObject({
      event_type: "state_entered",
      organization_id: orgId,
      team_id: "team-1",
      project_id: "project-1",
      assignee_id: "user-1",
      labels: ["bug"],
      to_state: "In Progress",
      from_state: "Todo",
      issue: {
        id: "issue-1",
        identifier: "SYM-1",
        state: "In Progress",
        state_id: "state-new",
        labels: ["bug"],
      },
      subject: { kind: "linear_issue", id: "issue-1" },
    });
  });

  it("treats issue creation as entering the initial state", () => {
    const result = mapIssueUpdateToEvent(
      envelope({ action: "create", updatedFrom: null }),
      orgId,
    );

    expect(result?.summary).toBe("SYM-1 → In Progress");
    expect(result?.event).toMatchObject({
      event_type: "state_entered",
      from_state: null,
      to_state: "In Progress",
    });
  });

  it("falls back to ids when optional names and relation objects are missing", () => {
    const result = mapIssueUpdateToEvent(
      envelope({
        updatedFrom: { stateId: "old-id" },
        data: {
          id: "issue-raw",
          stateId: "new-id",
          team: { id: "team-from-object" },
          project: { id: "project-from-object" },
          assignee: { id: "assignee-from-object" },
        },
      }),
      orgId,
    );

    expect(result?.summary).toBe("issue-raw → new-id");
    expect(result?.fromStateName).toBeNull();
    expect(result?.event).toMatchObject({
      team_id: "team-from-object",
      project_id: "project-from-object",
      assignee_id: "assignee-from-object",
      to_state: "new-id",
      issue: { identifier: null, title: null, description: null },
    });
  });

  it("ignores unsupported, malformed, and non-transition issue deliveries", () => {
    expect(mapIssueUpdateToEvent(envelope({ action: "remove" }), orgId)).toBeNull();
    expect(mapIssueUpdateToEvent(envelope({ data: undefined }), orgId)).toBeNull();
    expect(
      mapIssueUpdateToEvent(envelope({ data: { id: "issue-1" } }), orgId),
    ).toBeNull();
    expect(
      mapIssueUpdateToEvent(envelope({ updatedFrom: { stateId: "state-new" } }), orgId),
    ).toBeNull();
    expect(
      mapIssueUpdateToEvent(envelope({ updatedFrom: { title: "Old title" } }), orgId),
    ).toBeNull();
  });
});

describe("isIssueEnvelope", () => {
  it("accepts only Linear Issue envelopes with an action string", () => {
    expect(isIssueEnvelope({ type: "Issue", action: "update" })).toBe(true);
    expect(isIssueEnvelope({ type: "Comment", action: "create" })).toBe(false);
    expect(isIssueEnvelope({ type: "Issue", action: 123 })).toBe(false);
    expect(isIssueEnvelope(null)).toBe(false);
  });
});
