import { Hono } from "hono";

import type { Env } from "../index";
import { verifyLinearSignature } from "../lib/signature";
import type { AgentSessionEventWebhook } from "../types/agent-session";

export { summarizeStdout } from "../lib/session-helpers";

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
 *   3. Hand off to the `SESSION_RUNNER` Cloudflare Workflow which posts
 *      the initial `thought` activity, calls the dispatcher's `/run`
 *      route, and posts the terminal `response`/`error` activity. Each
 *      phase is its own durable step — a Worker eviction mid-dispatch
 *      resumes from the last completed step instead of dropping the
 *      session silently.
 *
 * Idempotency: Linear retries failed deliveries. We dedupe on
 * `webhookId + agentSession.id` via a short-lived KV entry. As a second
 * line of defense, the Workflow instance id is the `agentSession.id`,
 * so a concurrent retry that beats the KV write collides on the
 * Workflow id and is treated as success.
 */

const WEBHOOK_DEDUPE_TTL_S = 60 * 60;

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

      // Hand off to the durable Workflow; respond immediately so we
      // stay inside Linear's 5s ack budget regardless of dispatcher
      // latency. The Workflow instance id is the agent session id, so
      // a Linear retry that beats the KV dedupe write still collides
      // here — we catch the "instance exists" error and treat it as
      // success. Real new prompts on a running session are handled by
      // SYM-267 item 7 (mid-run comment ingestion).
      console.log("scheduling_session_runner", event.agentSession.id);
      try {
        await c.env.SESSION_RUNNER.create({
          id: event.agentSession.id,
          params: { event },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/instance.*exists|already/i.test(msg)) {
          console.error("workflow_create_failed", msg);
          throw e;
        }
        console.log("workflow_already_exists", event.agentSession.id);
      }
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

