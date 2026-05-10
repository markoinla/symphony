import { Hono } from "hono";
import { LinearClient } from "@linear/sdk";

import type { Env } from "../index";
import { verifyLinearSignature } from "../lib/signature";
import { DispatcherClient, DispatcherError } from "../lib/dispatcher";
import {
  postError,
  postResponse,
  postThought,
  type ActivityClient,
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
    const raw = await c.req.raw.clone().text();

    const ok = await verifyLinearSignature(
      c.env.LINEAR_WEBHOOK_SECRET,
      raw,
      c.req.header("linear-signature"),
    );
    if (!ok) {
      return c.json({ error: "invalid_signature" }, 401);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    if (!isAgentSessionEvent(parsed)) {
      // Other webhook categories (issue events, comment events) — ignore
      // for now. We only care about Agent Session events.
      return c.json({ ok: true, ignored: true });
    }

    const event = parsed;
    const dedupeKey = `webhook:${event.webhookId}:${event.agentSession.id}`;
    const seen = await c.env.LINEAR_TOKENS.get(dedupeKey);
    if (seen) {
      return c.json({ ok: true, deduped: true });
    }
    await c.env.LINEAR_TOKENS.put(dedupeKey, "1", {
      expirationTtl: WEBHOOK_DEDUPE_TTL_S,
    });

    if (event.action !== "created" && event.action !== "prompted") {
      return c.json({ ok: true, ignored: true, action: event.action });
    }

    // Hand off the long-running work; respond immediately so we stay
    // inside Linear's 5s ack budget regardless of dispatcher latency.
    c.executionCtx.waitUntil(runSession(c.env, event));
    return c.json({ ok: true, scheduled: true });
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

  const linear = new LinearClient({ accessToken });
  const sessionId = event.agentSession.id;

  await safe(() =>
    postThought(linear as unknown as ActivityClient, sessionId, "Picked this up — working on it."),
  );

  const repoUrl = resolveRepoUrl(env, event.agentSession);
  if (!repoUrl) {
    await safe(() =>
      postError(
        linear as unknown as ActivityClient,
        sessionId,
        "No repository is configured for this team. Add one in `PROJECT_MAPPINGS_JSON` or the project config.",
      ),
    );
    return;
  }

  const prompt = event.agentSession.promptContext?.trim();
  if (!prompt) {
    await safe(() =>
      postError(
        linear as unknown as ActivityClient,
        sessionId,
        "No prompt context in the session payload — nothing to act on.",
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
          linear as unknown as ActivityClient,
          sessionId,
          summarizeStdout(result.stdout) ||
            `Run finished in ${(result.duration_ms / 1000).toFixed(1)}s.`,
        ),
      );
    } else {
      await safe(() =>
        postError(
          linear as unknown as ActivityClient,
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
      postError(linear as unknown as ActivityClient, sessionId, msg),
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

function summarizeStdout(stdout: string): string {
  // Pi's `--mode json` emits one event per line. The terminal `response`
  // event is what we want to surface as the Linear `response` activity.
  // If we can't find one, fall back to the trailing chunk of stdout.
  const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; body?: string };
      if (parsed.type === "response" && typeof parsed.body === "string") {
        return parsed.body;
      }
    } catch {
      // Not JSON — pi may emit interleaved plain output. Skip.
    }
  }
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
