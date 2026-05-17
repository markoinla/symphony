/**
 * Internal ingest route for the engine-push architecture (SYM-386).
 *
 * The sandbox forwarder POSTs batches of raw `pi --print --mode json`
 * NDJSON lines here as the run progresses. This route normalizes them,
 * persists timeline rows to `agent_session_events`, posts live Linear
 * activities for Linear-attached sessions, and — on the terminal batch
 * — wakes the run's `SessionRunner` workflow instance via `sendEvent`.
 *
 * It replaces the dispatcher's SSE stream + `/run/attach` re-attach: the
 * engine pushes its own events to durable storage instead of the
 * Workflow holding a live connection open across step evictions.
 *
 * Auth: per-run HMAC. The sandbox only ever holds a per-run token —
 * `HMAC-SHA256(DISPATCH_HMAC_SECRET, sessionId)` — never the master
 * secret. The forwarder signs each batch body with that token; this
 * route recomputes the token from the path's `sessionId` and verifies.
 *
 * Nothing dispatches to this route yet — the dispatcher forwarder
 * (phase 2) and the Workflow rewire (phase 3) land separately.
 */

import { Hono } from "hono";

import type { Env } from "../index";
import { buildActivityClient } from "../lib/activities";
import {
  RUN_TERMINAL_EVENT,
  type NormalizedEvent,
  type RunTerminalPayload,
} from "../lib/dispatcher";
import { parsePiLine, summarizeEvent } from "../lib/engine-pi";
import { mapToActivity } from "../lib/event-mapper";
import {
  refreshInstallToken,
  refreshInstallTokenIfNeeded,
} from "../lib/install-token";
import { computeHmacSignature, verifyHmacSignature } from "../lib/signature";
import {
  AgentSessionEventStore,
  AgentSessionStore,
  type AgentSessionRecord,
} from "../lib/store";

// Matches the dispatcher's run-timeout default; used only to decide
// whether to proactively refresh the Linear install token before
// posting activities.
const TOKEN_REFRESH_WINDOW_MS = 10 * 60 * 1000;

interface IngestBody {
  instance_id?: unknown;
  lines?: unknown;
  exit?: unknown;
}

interface ParsedExit {
  code: number;
  stderrTail: string;
}

export function buildInternalRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/internal/run-events/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");

    const secret = c.env.DISPATCH_HMAC_SECRET;
    if (!secret) {
      return c.json({ error: "dispatcher_misconfigured" }, 500);
    }

    // Read the body once; the signature is over the exact raw bytes.
    const rawBody = await c.req.text();

    // Per-run token = HMAC(masterSecret, sessionId). The forwarder signs
    // the batch body with this token; we recompute it and verify.
    const perRunToken = await computeHmacSignature(secret, sessionId, "sha256");
    const provided = c.req.header("x-symphony-signature");
    const signatureOk = await verifyHmacSignature(
      perRunToken,
      rawBody,
      provided,
      "sha256",
    );
    if (!signatureOk) {
      return c.json({ error: "invalid_signature" }, 401);
    }

    let body: IngestBody;
    try {
      body = JSON.parse(rawBody) as IngestBody;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    if (typeof body.instance_id !== "string" || body.instance_id.length === 0) {
      return c.json({ error: "invalid_instance_id" }, 400);
    }
    const instanceId = body.instance_id;

    const lines = parseLines(body.lines);
    if (lines === null) {
      return c.json({ error: "invalid_lines" }, 400);
    }

    const exit = parseExit(body.exit);
    if (exit === "invalid") {
      return c.json({ error: "invalid_exit" }, 400);
    }

    const session = await new AgentSessionStore(c.env.DB).get(sessionId);
    if (!session) {
      return c.json({ error: "unknown_session" }, 404);
    }

    const eventStore = new AgentSessionEventStore(c.env.DB);
    const now = Date.now();

    // Normalize the raw pi NDJSON into timeline events and persist them.
    const events: NormalizedEvent[] = [];
    for (const line of lines) events.push(...parsePiLine(line));
    if (events.length > 0) {
      await eventStore.appendBatch(
        sessionId,
        events.map((ev) => ({
          turn: 1,
          ts: now,
          type: ev.type,
          body: summarizeEvent(ev),
        })),
      );
    }

    // Post live Linear activities for Linear-attached sessions. Posts
    // are serial (timeline order) and best-effort — a Linear API hiccup
    // never fails the ingest. Headless trigger runs have no Linear
    // AgentSession (linear_issue_id IS NULL) and skip this entirely.
    if (events.length > 0 && session.linear_issue_id) {
      await postActivities(c.env, session, events);
    }

    if (!exit) {
      return c.json({ ok: true, ingested: events.length, terminal: false });
    }

    // Terminal batch: record a synthetic `result` row, then wake the
    // workflow with the run's exit status + final message.
    await eventStore.append(sessionId, {
      turn: 1,
      ts: now,
      type: "result",
      body: `exit_code=${exit.code}`,
    });

    const lastAssistant = await eventStore.lastAssistantBody(sessionId);
    const error =
      exit.code === 0
        ? null
        : exit.stderrTail.trim() || `engine exited with code ${exit.code}`;
    const payload: RunTerminalPayload = {
      exit_code: exit.code,
      error,
      last_assistant: lastAssistant,
    };

    let woke = false;
    try {
      const instance = await c.env.SESSION_RUNNER.get(instanceId);
      await instance.sendEvent({ type: RUN_TERMINAL_EVENT, payload });
      woke = true;
    } catch (e) {
      // The Workflow may have been terminated (Linear `stop`) or already
      // GC'd. Events are persisted regardless; the reconciler cron
      // closes out any session whose runner is gone. Don't fail the
      // forwarder — a retry can't conjure a missing instance.
      console.error(
        "run_terminal_send_event_failed",
        JSON.stringify({
          session_id: sessionId,
          instance_id: instanceId,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }

    return c.json({
      ok: true,
      ingested: events.length,
      terminal: true,
      woke,
    });
  });

  return app;
}

async function postActivities(
  env: Env,
  session: AgentSessionRecord,
  events: NormalizedEvent[],
): Promise<void> {
  const refreshed = await refreshInstallTokenIfNeeded(
    env,
    session.organization_id,
    TOKEN_REFRESH_WINDOW_MS,
  );
  if (!refreshed) {
    console.warn(
      "ingest_activities_no_token",
      JSON.stringify({ session_id: session.id }),
    );
    return;
  }

  let token = refreshed.accessToken;
  const linear = buildActivityClient(token, async () => {
    const r = await refreshInstallToken(env, session.organization_id);
    if (r) token = r.accessToken;
    return r?.accessToken ?? null;
  });

  for (const ev of events) {
    const activity = mapToActivity(ev);
    if (!activity) continue;
    try {
      await linear.createAgentActivity({
        agentSessionId: session.id,
        content: activity,
      });
    } catch (e) {
      console.error(
        "ingest_activity_post_failed",
        JSON.stringify({
          session_id: session.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }
}

/** Coerce the `lines` field to a string[]; null on a type violation. */
function parseLines(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

/**
 * Coerce the optional `exit` field. Returns `undefined` when absent (a
 * non-terminal batch), a parsed exit when valid, or the literal
 * `"invalid"` on a malformed value.
 */
function parseExit(value: unknown): ParsedExit | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return "invalid";
  const exit = value as { code?: unknown; stderr_tail?: unknown };
  if (typeof exit.code !== "number" || !Number.isFinite(exit.code)) {
    return "invalid";
  }
  if (exit.stderr_tail !== undefined && typeof exit.stderr_tail !== "string") {
    return "invalid";
  }
  return {
    code: Math.trunc(exit.code),
    stderrTail: typeof exit.stderr_tail === "string" ? exit.stderr_tail : "",
  };
}
