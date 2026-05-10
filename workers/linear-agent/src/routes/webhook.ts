import { Hono } from "hono";

import type { Env } from "../index";
import { verifyLinearSignature } from "../lib/signature";
import { DispatcherClient, DispatcherError } from "../lib/dispatcher";
import {
  buildActivityClient,
  postError,
  postResponse,
  postThought,
} from "../lib/activities";
import type {
  AgentSession,
  AgentSessionEventWebhook,
} from "../types/agent-session";

/**
 * Linear webhook receiver for Agent Session events.
 *
 * Linear's SLAs (https://linear.app/developers/agents):
 *   - HTTP 2xx within 5 seconds
 *   - First activity within 10 seconds
 *
 * Implementation strategy to honor both:
 *   1. Verify HMAC and parse — pure synchronous work, < ~50 ms.
 *   2. Acknowledge with 200 immediately.
 *   3. In `executionCtx.waitUntil`, post the initial `thought` activity,
 *      then call the dispatcher's `/run` route, then post the terminal
 *      `response`/`error` activity.
 *
 * Idempotency: Linear retries failed deliveries. We dedupe on
 * `webhookId + agentSession.id` via a short-lived KV entry. If we've
 * already started a run for this delivery we ack and return.
 *
 * Step 4 of the build plan replaces the inline `runSession` body with a
 * Cloudflare Workflow so the dispatcher call survives Worker restarts.
 * The webhook itself stays the same — it always just posts the immediate
 * `thought` and hands off.
 */

const WEBHOOK_DEDUPE_TTL_S = 60 * 60;

interface ProjectMapping {
  [linearTeamId: string]: string;
}

export function buildWebhookRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/webhook", async (c) => {
    console.log("webhook_enter");
    try {
      const raw = await c.req.raw.clone().text();
      console.log("webhook_body_read", raw.length);

      const sigHeader = c.req.header("linear-signature");
      console.log("got_sig_header", typeof sigHeader, sigHeader?.slice(0, 16));
      const secret = c.env.LINEAR_WEBHOOK_SECRET;
      console.log("got_secret", typeof secret, secret ? secret.length : 0);
      const ok = await verifyLinearSignature(secret, raw, sigHeader);
      console.log("signature_verified", ok);
      if (!ok) {
        return c.json({ error: "invalid_signature" }, 401);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return c.json({ error: "invalid_json" }, 400);
      }
      console.log("json_parsed", typeof parsed);
      // One-time diagnostic: dump the top-level keys + type field so we
      // can see what envelope Linear is actually sending.
      try {
        const p = parsed as Record<string, unknown>;
        console.log(
          "parsed_keys",
          Object.keys(p).join(","),
          "type=",
          String(p.type),
          "action=",
          String(p.action),
          "hasAgentSession=",
          !!p.agentSession,
        );
      } catch {}

      if (!isAgentSessionEvent(parsed)) {
        console.log("ignored_not_agent_session_event");
        // Other webhook categories (issue events, comment events) — ignore
        // for now. We only care about Agent Session events.
        return c.json({ ok: true, ignored: true });
      }

      const event = parsed;
      console.log("agent_session_event", event.action, event.agentSession.id);
      const dedupeKey = `webhook:${event.webhookId}:${event.agentSession.id}`;
      const seen = await c.env.LINEAR_TOKENS.get(dedupeKey);
      console.log("dedupe_check", seen ? "seen" : "fresh");
      if (seen) {
        return c.json({ ok: true, deduped: true });
      }
      await c.env.LINEAR_TOKENS.put(dedupeKey, "1", {
        expirationTtl: WEBHOOK_DEDUPE_TTL_S,
      });
      console.log("dedupe_marked");

      if (event.action !== "created" && event.action !== "prompted") {
        return c.json({ ok: true, ignored: true, action: event.action });
      }

      // Hand off the long-running work; respond immediately so we stay
      // inside Linear's 5s ack budget regardless of dispatcher latency.
      // Explicit `.bind()` belt-and-suspenders: even though calling
      // `.waitUntil` directly off `c.executionCtx` should preserve `this`,
      // some Hono/Workers combinations have surfaced "Illegal invocation"
      // here. Binding eliminates the possibility entirely.
      console.log("getting_exec_ctx");
      const ctx = c.executionCtx;
      console.log("scheduling_run_session");
      ctx.waitUntil.bind(ctx)(runSession(c.env, event));
      console.log("returning_200");
      return c.json({ ok: true, scheduled: true });
    } catch (e) {
      // Surface the real error to Linear's webhook delivery log instead of
      // letting Workers turn it into an opaque "Illegal invocation".
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const stack = e instanceof Error ? e.stack ?? "" : "";
      console.error("webhook_handler_error", msg, "\n", stack);
      return c.json({ error: "webhook_handler_error", message: msg, stack }, 500);
    }
  });

  return app;
}

export async function runSession(
  env: Env,
  event: AgentSessionEventWebhook,
): Promise<void> {
  const accessToken = await env.LINEAR_TOKENS.get("access_token");
  if (!accessToken) {
    // Nothing we can post back to Linear without the token — log and bail.
    console.error(
      "no_access_token",
      JSON.stringify({ session_id: event.agentSession.id }),
    );
    return;
  }

  const linear = buildActivityClient(accessToken);
  const sessionId = event.agentSession.id;

  await safe(() => postThought(linear, sessionId, "Picked this up — working on it."));

  const repoUrl = resolveRepoUrl(env, event.agentSession);
  if (!repoUrl) {
    await safe(() =>
      postError(
        linear,
        sessionId,
        "No repository is configured for this team. Add one in `PROJECT_MAPPINGS_JSON` or the project config.",
      ),
    );
    return;
  }

  const prompt = resolvePrompt(event);
  if (!prompt) {
    await safe(() =>
      postError(
        linear,
        sessionId,
        "Couldn't find a prompt in the session payload (no promptContext, comment body, or issue description).",
      ),
    );
    return;
  }

  const dispatcher = new DispatcherClient(env.DISPATCHER_URL, env.DISPATCH_HMAC_SECRET);

  const issueIdentifier = event.agentSession.issue?.identifier ?? sessionId;

  try {
    const result = await dispatcher.run({
      scope: env.DEFAULT_SCOPE,
      issueId: issueIdentifier,
      repoUrl,
      prompt,
      engine: (env.DEFAULT_ENGINE as "pi") ?? "pi",
      model: env.DEFAULT_MODEL || null,
    });

    if (result.exit_code === 0) {
      await safe(() =>
        postResponse(
          linear,
          sessionId,
          summarizeStdout(result.stdout) ||
            `Run finished in ${(result.duration_ms / 1000).toFixed(1)}s.`,
        ),
      );
    } else {
      await safe(() =>
        postError(
          linear,
          sessionId,
          `Engine exited with code ${result.exit_code}.\n\n` +
            "```\n" +
            truncate(result.stderr || result.stdout, 2000) +
            "\n```",
        ),
      );
    }
  } catch (e) {
    const msg =
      e instanceof DispatcherError
        ? `Dispatcher error (${e.status}): ${typeof e.body === "string" ? e.body : e.body.error}`
        : e instanceof Error
          ? e.message
          : "unknown_dispatcher_error";
    await safe(() =>
      postError(linear, sessionId, msg),
    );
  }
}

function isAgentSessionEvent(value: unknown): value is AgentSessionEventWebhook {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== "AgentSessionEvent") return false;
  if (typeof v.webhookId !== "string") return false;
  if (typeof v.action !== "string") return false;
  if (!v.agentSession || typeof v.agentSession !== "object") return false;
  const session = v.agentSession as Record<string, unknown>;
  if (typeof session.id !== "string") return false;
  return true;
}

/**
 * Pull the user's actual question out of the webhook payload.
 *
 * Linear's AgentSessionEvent webhook envelopes are NOT what older docs
 * suggest — the rich context lives at the top level of the event, not
 * inside `agentSession`. Fields we draw from, in priority order:
 *
 *   - `event.promptContext` — pre-rendered markdown with the issue
 *     title, description, and any kickoff comment. This is the
 *     primary source for assignment-style sessions.
 *   - `event.agentSession.comment.body` — the actual comment body when
 *     the session is started by an @-mention.
 *   - `event.agentSession.issue.title` — last-resort fallback so we
 *     never error out for "no prompt" if Linear sent a session-start
 *     event with only the issue header.
 *
 * `event.guidance`, when present, is appended as a "Guidance:" section
 * so workspace-level instructions (e.g. "always run lint before
 * proposing edits") reach the model.
 *
 * Strips literal `@<bot-name>` tokens so the model doesn't waste
 * attention parsing them.
 */
function resolvePrompt(event: AgentSessionEventWebhook): string | null {
  const session = event.agentSession;
  const candidates = [
    event.promptContext,
    session.comment?.body,
    session.issue?.title && session.issue?.title.trim().length > 0
      ? `Issue ${session.issue.identifier ?? ""}: ${session.issue.title}`.trim()
      : null,
  ];

  let base: string | null = null;
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const stripped = c.replace(/@[A-Za-z0-9_-]+/g, "").trim();
    if (stripped.length > 0) {
      base = stripped;
      break;
    }
  }
  if (!base) return null;

  const guidance =
    typeof event.guidance === "string" && event.guidance.trim().length > 0
      ? event.guidance.trim()
      : null;
  return guidance ? `${base}\n\n---\nGuidance:\n${guidance}` : base;
}

function resolveRepoUrl(env: Env, session: AgentSession): string | null {
  const teamId = session.issue?.teamId ?? session.issue?.team?.id;
  if (!teamId) return null;
  let mapping: ProjectMapping;
  try {
    mapping = JSON.parse(env.PROJECT_MAPPINGS_JSON || "{}") as ProjectMapping;
  } catch {
    return null;
  }
  return mapping[teamId] ?? null;
}

interface PiMessageContent {
  type?: string;
  text?: string;
}

interface PiMessageEnd {
  type?: string;
  message?: {
    role?: string;
    content?: PiMessageContent[];
  };
  assistantMessageEvent?: { type?: string; delta?: string };
}

/**
 * Extract a human-readable answer from pi's `--mode json` event stream.
 *
 * Pi emits one JSON event per line. Lifecycle events (`session`,
 * `agent_start`, etc.) are noise; the answer lives in `message_end`
 * events whose `message.role === "assistant"` and contain a
 * `content[].type === "text"` chunk. A single run may produce several
 * assistant messages (after thinking, after each tool call, then the
 * final answer) — we want the LAST one with text content.
 *
 * Fallback chain: last assistant text → reconstructed from
 * `text_delta` events → truncated raw stdout.
 */
export function summarizeStdout(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);

  let lastAssistantText: string | null = null;
  const deltaChunks: string[] = [];

  for (const line of lines) {
    let ev: PiMessageEnd;
    try {
      ev = JSON.parse(line) as PiMessageEnd;
    } catch {
      continue;
    }
    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      const text = (ev.message.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      if (text.length > 0) lastAssistantText = text;
    }
    if (
      ev.type === "message_update" &&
      ev.assistantMessageEvent?.type === "text_delta" &&
      typeof ev.assistantMessageEvent.delta === "string"
    ) {
      deltaChunks.push(ev.assistantMessageEvent.delta);
    }
  }

  if (lastAssistantText) return lastAssistantText;
  const reconstructed = deltaChunks.join("");
  if (reconstructed.length > 0) return reconstructed;
  return truncate(stdout, 2000);
}

function truncate(s: string, limit: number): string {
  return s.length <= limit ? s : s.slice(0, limit) + "\n…[truncated]";
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error("activity_post_failed", e instanceof Error ? e.message : e);
  }
}
