import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../dashboard/src/lib/auth-client", () => ({
  authClient: {},
}));

import { getSessions } from "../dashboard/src/lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dashboard API adapter", () => {
  it("maps real Linear issue keys without deriving them from titles", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        sessions: [
          {
            id: "session-real-key",
            linear_issue_id: "linear-issue-id",
            linear_issue_identifier: "SYM-359",
            linear_issue_title: "Human editable title that is not a key",
            status: "complete",
            started_at: "2023-11-14T22:13:20.000Z",
            completed_at: "2023-11-14T22:23:20.000Z",
            triggered_by: "created",
            team: "SYM",
            repo: "https://github.com/markoinla/symphony",
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const payload = await getSessions();

    expect(payload.sessions[0]).toMatchObject({
      issue_identifier: "SYM-359",
      issue_title: "Human editable title that is not a key",
      session_id: "session-real-key",
      detail_session_id: "session-real-key",
      started_at: "2023-11-14T22:13:20.000Z",
      ended_at: "2023-11-14T22:23:20.000Z",
    });
    expect(payload.sessions[0]!.issue_identifier).not.toBe(
      "Human editable title that is not a key",
    );
    expect(new Date(payload.sessions[0]!.started_at!).getUTCFullYear()).toBe(
      2023,
    );
  });

  it("keeps a stable session detail id when no Linear issue key exists", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        sessions: [
          {
            id: "session-without-linear-key",
            linear_issue_id: null,
            linear_issue_identifier: null,
            linear_issue_title: "Ad hoc dashboard run",
            status: "complete",
            started_at: "2023-11-14T22:13:20.000Z",
            completed_at: null,
            triggered_by: "manual",
            team: null,
            repo: null,
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const payload = await getSessions({ issueIdentifier: "session-without-linear-key" });

    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]).toMatchObject({
      issue_identifier: null,
      issue_title: "Ad hoc dashboard run",
      session_id: "session-without-linear-key",
      detail_session_id: "session-without-linear-key",
    });
  });
});
