import { Hono } from "hono";

import type { Env } from "../index";
import { buildActivityClient, postResponse } from "../lib/activities";
import { DispatcherClient } from "../lib/dispatcher";
import { dispatchTrigger } from "../lib/dispatch-trigger";
import { refreshInstallToken } from "../lib/install-token";
import {
  isIssueEnvelope,
  mapIssueUpdateToEvent,
  type IssueWebhookEnvelope,
} from "../lib/event-mapper-inbound";
import {
  buildSentryEventTuple,
  normalizeSentryWebhook,
  verifySentrySignature,
} from "../lib/sentry";
import { readJsonPath } from "../lib/json-path";
import { verifyHmacSignature, verifyLinearSignature } from "../lib/signature";
import {
  AgentSessionStore,
  GitHubInstallStore,
  LinearAgentInstallStore,
  WebhookEventStore,
  WebhookSourceStore,
  type WebhookSourceRecord,
} from "../lib/store";
import { resolveWorkflow } from "../lib/workflows/resolver";
import {
  normalizeGitHubIssueCommentEvent,
  normalizeGitHubIssuesEvent,
  normalizeGitHubPullRequestEvent,
  verifyGitHubSignature,
} from "../lib/github-webhook";
import { ensureDefaultWorkflow } from "../lib/workflows/seed";
import { WebhookSourceConfigSchema } from "../schemas/webhook-source";
import type { EventTuple } from "../schemas/event";
import type { AgentSessionEventWebhook } from "../types/agent-session";

export { summarizeStdout } from "../lib/session-helpers";

/**
 * Linear webhook receiver.
 *
 * Two envelopes are processed today:
 *
 *   1. `AgentSessionEvent` — created/prompted from Linear's Agents
 *      platform. Hands off to the `SESSION_RUNNER` workflow which
 *      drives a turn loop and writes activities back into the Linear
 *      session timeline.
 *
 *   2. `Issue` (action: "update") — standard Linear issue webhooks.
 *      State transitions are mapped to a `state_entered` EventTuple,
 *      resolved against `workflow_triggers`, and dispatched via
 *      `dispatchTrigger`. Trigger-initiated sessions have no Linear
 *      AgentSession id so they don't post back into Linear; they're
 *      visible on `/dashboard/webhooks` and `/dashboard/sessions`.
 *
 * Every delivery records a row in `webhook_events` for the dashboard's
 * "did this fire?" view, regardless of envelope or outcome.
 *
 * Linear's SLAs (https://linear.app/developers/agents):
 *   - HTTP 2xx within 5 seconds
 *   - First activity within 10 seconds
 *
 * Idempotency: Linear retries failed deliveries. `AgentSessionEvent`
 * dedupes on `(webhookId, agentSession.id)` via a 60-min KV entry +
 * the Workflow instance id collision (instance id = agentSession.id).
 * Issue envelopes dedupe on `(webhookId, data.id, data.stateId)` so
 * a retried state transition doesn't double-dispatch.
 */

const WEBHOOK_DEDUPE_TTL_S = 60 * 60;

export function buildWebhookRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/webhook/source/:id", async (c) => {
    const receivedAt = Math.floor(Date.now() / 1000);
    const startedMs = Date.now();
    const events = new WebhookEventStore(c.env.DB);
    const sourceId = c.req.param("id");
    const source = await new WebhookSourceStore(c.env.DB).getById(sourceId);

    if (!source) {
      const raw = await c.req.raw.clone().text().catch(() => "");
      await events.insert({
        receivedAt,
        sourceId,
        envelopeType: "unknown",
        signatureOk: false,
        rawBody: raw.slice(0, 65_536),
        eventSummary: "Unknown webhook source",
      });
      return c.json({ error: "unknown_source" }, 404);
    }

    if (source.kind === "github") {
      return await handleGitHubSource(c, source, events, receivedAt, startedMs);
    }

    if (source.kind === "generic") {
      return await handleGenericSource(c, source, events, startedMs);
    }

    if (source.kind === "sentry") {
      return await handleSentrySource(c, source, events, receivedAt, startedMs);
    }

    const raw = await c.req.raw.clone().text().catch(() => "");
    const logId = await events.insert({
      receivedAt,
      organizationId: source.organization_id,
      sourceId: source.id,
      envelopeType: source.kind,
      signatureOk: false,
      rawBody: raw.slice(0, 65_536),
    });
    await events.update(logId, {
      dispatchedAction: "error",
      error: "unsupported_source_kind",
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ error: "unsupported_source_kind" }, 400);
  });

  // App-level GitHub webhook. A GitHub App has exactly one webhook URL
  // shared by every installation across every tenant, so this route is
  // fixed (not per-source) and resolves the tenant org from the
  // payload's `installation.id`. The per-source `/webhook/source/:id`
  // route stays for repo-level (non-App) GitHub webhooks.
  app.post("/webhook/github", async (c) => {
    const receivedAt = Math.floor(Date.now() / 1000);
    const startedMs = Date.now();
    const events = new WebhookEventStore(c.env.DB);
    return await handleGitHubAppWebhook(c, events, receivedAt, startedMs);
  });

  app.post("/webhook", async (c) => {
    const receivedAt = Math.floor(Date.now() / 1000);
    const startedMs = Date.now();
    console.log("webhook_enter");
    const events = new WebhookEventStore(c.env.DB);
    let logId: string | null = null;
    let orgIdForLog: string | null = null;

    try {
      const raw = await c.req.raw.clone().text();
      console.log("webhook_body_read", raw.length);

      const sigHeader = c.req.header("linear-signature");
      const secret = c.env.LINEAR_WEBHOOK_SECRET;
      const sigOk = await verifyLinearSignature(secret, raw, sigHeader);
      console.log("signature_verified", sigOk);

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        logId = await events.insert({
          receivedAt,
          envelopeType: "unknown",
          signatureOk: sigOk,
          rawBody: raw.slice(0, 65_536),
        });
        await events.update(logId, {
          dispatchedAction: "error",
          error: "invalid_json",
          latencyMs: Date.now() - startedMs,
        });
        return c.json({ error: "invalid_json" }, 400);
      }

      const envelopeType = inferEnvelopeType(parsed);
      const envelopeAction =
        typeof parsed?.action === "string" ? (parsed.action as string) : null;
      const webhookId =
        typeof parsed?.webhookId === "string"
          ? (parsed.webhookId as string)
          : null;

      logId = await events.insert({
        receivedAt,
        webhookId,
        envelopeType,
        envelopeAction,
        signatureOk: sigOk,
        rawBody: raw.slice(0, 65_536),
      });

      if (!sigOk) {
        await events.update(logId, {
          dispatchedAction: "error",
          error: "invalid_signature",
          latencyMs: Date.now() - startedMs,
        });
        return c.json({ error: "invalid_signature" }, 401);
      }

      if (isAgentSessionEvent(parsed)) {
        return await handleAgentSession(c, parsed, logId, events, startedMs);
      }

      if (isIssueEnvelope(parsed)) {
        // Tenant resolution for the log row.
        const linearOrgId =
          typeof (parsed as IssueWebhookEnvelope).organizationId === "string"
            ? ((parsed as IssueWebhookEnvelope).organizationId as string)
            : null;
        if (linearOrgId) {
          const install = await new LinearAgentInstallStore(
            c.env.DB,
          ).getByLinearOrgId(linearOrgId);
          if (install) orgIdForLog = install.organization_id;
        }
        return await handleIssueEnvelope(
          c,
          parsed as IssueWebhookEnvelope,
          {
            logId,
            orgId: orgIdForLog,
            envelopeAction,
            startedMs,
            events,
          },
        );
      }

      console.log("ignored_unhandled_envelope", envelopeType);
      await events.update(logId, {
        dispatchedAction: "ignored_envelope",
        latencyMs: Date.now() - startedMs,
        eventSummary: `Ignored ${envelopeType}`,
      });
      return c.json({ ok: true, ignored: true });
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const stack = e instanceof Error ? e.stack ?? "" : "";
      console.error("webhook_handler_error", msg, "\n", stack);
      if (logId) {
        try {
          await events.update(logId, {
            dispatchedAction: "error",
            error: msg,
            latencyMs: Date.now() - startedMs,
          });
        } catch {}
      }
      return c.json({ error: "webhook_handler_error", message: msg, stack }, 500);
    }
  });

  return app;
}

async function handleSentrySource(
  c: {
    env: Env;
    req: { raw: Request; header: (name: string) => string | undefined };
    json: (b: unknown, s?: number) => Response;
  },
  source: WebhookSourceRecord,
  events: WebhookEventStore,
  receivedAt: number,
  startedMs: number,
): Promise<Response> {
  const sourceStore = new WebhookSourceStore(c.env.DB);
  const raw = await c.req.raw.clone().text();

  if (source.enabled === 0) {
    const logId = await events.insert({
      receivedAt,
      organizationId: source.organization_id,
      sourceId: source.id,
      envelopeType: "sentry.unknown",
      signatureOk: false,
      rawBody: raw.slice(0, 65_536),
    });
    await events.update(logId, {
      dispatchedAction: "error",
      error: "webhook_source_disabled",
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ error: "webhook_source_not_found" }, 404);
  }

  const signatureOk = await verifySentrySignature(
    source.secret,
    raw,
    c.req.header("Sentry-Hook-Signature"),
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const logId = await events.insert({
      receivedAt,
      organizationId: source.organization_id,
      sourceId: source.id,
      envelopeType: "sentry.unknown",
      signatureOk,
      rawBody: raw.slice(0, 65_536),
    });
    await events.update(logId, {
      dispatchedAction: "error",
      error: "invalid_json",
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ error: "invalid_json" }, 400);
  }

  let normalized;
  try {
    normalized = normalizeSentryWebhook(parsed, source);
  } catch (e) {
    const logId = await events.insert({
      receivedAt,
      organizationId: source.organization_id,
      sourceId: source.id,
      envelopeType: "sentry.unknown",
      signatureOk,
      rawBody: raw.slice(0, 65_536),
    });
    await events.update(logId, {
      dispatchedAction: "error",
      error: e instanceof Error ? e.message : String(e),
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ error: "invalid_payload" }, 400);
  }

  const logId = await events.insert({
    receivedAt,
    organizationId: source.organization_id,
    sourceId: source.id,
    webhookId: normalized.webhookId,
    envelopeType: normalized.eventType,
    envelopeAction:
      typeof (parsed as Record<string, unknown>).action === "string"
        ? ((parsed as Record<string, unknown>).action as string)
        : null,
    signatureOk,
    rawBody: raw.slice(0, 65_536),
    eventSummary: normalized.summary,
  });

  if (!signatureOk) {
    await events.update(logId, {
      dispatchedAction: "error",
      error: "invalid_signature",
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ error: "invalid_signature" }, 401);
  }

  const dedupeKey = `webhook-source:${source.id}:${normalized.webhookId}:${normalized.eventType}`;
  const seen = await c.env.LINEAR_TOKENS.get(dedupeKey);
  if (seen) {
    await events.update(logId, {
      deduped: true,
      dispatchedAction: "deduped",
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, deduped: true });
  }
  await c.env.LINEAR_TOKENS.put(dedupeKey, "1", {
    expirationTtl: WEBHOOK_DEDUPE_TTL_S,
  });
  await sourceStore.touch(source.id);

  const event = buildSentryEventTuple({
    orgId: source.organization_id,
    source,
    normalized,
  });
  const resolved = await resolveWorkflow(c.env, event);
  if (!resolved) {
    await events.update(logId, {
      dispatchedAction: "no_match",
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, matched: false });
  }

  const result = await dispatchTrigger(c.env, {
    workflow: resolved.workflow,
    trigger: resolved.trigger,
    event,
    context: normalized.context,
    source: "webhook",
  });
  await events.update(logId, {
    matchedWorkflowId: resolved.workflow.id,
    matchedTriggerId: resolved.trigger.id,
    dispatchedAction: result.outcome,
    agentSessionId: result.agentSessionId ?? null,
    error: result.error ?? null,
    latencyMs: Date.now() - startedMs,
  });
  if (result.outcome === "error") {
    return c.json({ error: result.error ?? "dispatch_failed" }, 500);
  }
  return c.json({ ok: true, matched: true, session_id: result.agentSessionId ?? null });
}

async function handleGenericSource(
  c: {
    env: Env;
    req: { raw: Request; header: (name: string) => string | undefined };
    json: (b: unknown, s?: number) => Response;
  },
  source: WebhookSourceRecord,
  events: WebhookEventStore,
  startedMs: number,
): Promise<Response> {
  const receivedAt = Math.floor(Date.now() / 1000);
  const raw = await c.req.raw.clone().text();
  const logId = await events.insert({
    receivedAt,
    organizationId: source.organization_id,
    sourceId: source.id,
    webhookId: source.id,
    envelopeType: "generic.webhook",
    envelopeAction: "post",
    signatureOk: false,
    rawBody: raw.slice(0, 65_536),
  });

  try {
    if (source.enabled === 0) {
      await events.update(logId, {
        dispatchedAction: "disabled_source",
        error: "disabled_source",
        latencyMs: Date.now() - startedMs,
      });
      return c.json({ error: "not_found" }, 404);
    }

    const rawConfig = source.config
      ? (JSON.parse(source.config) as Record<string, unknown>)
      : {};
    const config = WebhookSourceConfigSchema.parse(rawConfig);
    const signature = c.req.header(config.signature_header);
    const sigOk = await verifyHmacSignature(
      source.secret,
      raw,
      signature,
      config.signature_algorithm,
    );
    await events.update(logId, { signatureOk: sigOk });
    if (!sigOk) {
      await events.update(logId, {
        dispatchedAction: "error",
        error: "invalid_signature",
        latencyMs: Date.now() - startedMs,
      });
      return c.json({ error: "invalid_signature" }, 401);
    }

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("payload_not_object");
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      await events.update(logId, {
        dispatchedAction: "error",
        error: "invalid_json",
        latencyMs: Date.now() - startedMs,
      });
      return c.json({ error: "invalid_json" }, 400);
    }

    const extracted = readJsonPath(payload, config.external_id_path);
    const externalId =
      typeof extracted === "string" && extracted.trim() !== ""
        ? extracted.trim()
        : crypto.randomUUID();
    const dedupeKey = `webhook-source:${source.id}:${externalId}`;
    if (await c.env.LINEAR_TOKENS.get(dedupeKey)) {
      await events.update(logId, {
        deduped: true,
        dispatchedAction: "deduped",
        eventSummary: `Generic webhook ${externalId}`,
        latencyMs: Date.now() - startedMs,
      });
      return c.json({ ok: true, deduped: true });
    }
    await c.env.LINEAR_TOKENS.put(dedupeKey, "1", { expirationTtl: 60 });

    const event: EventTuple = {
      event_type: "generic.webhook",
      organization_id: source.organization_id,
      team_id: null,
      project_id: null,
      user_id: null,
      assignee_id: null,
      labels: [],
      subject: { kind: "generic", external_id: externalId, payload },
      issue: null,
      actor_id: null,
      context: { payload },
    };
    const resolved = await resolveWorkflow(c.env, event);
    if (!resolved) {
      await events.update(logId, {
        dispatchedAction: "no_match",
        eventSummary: `Generic webhook ${externalId}`,
        latencyMs: Date.now() - startedMs,
      });
      await new WebhookSourceStore(c.env.DB).touch(source.id);
      return c.json({ ok: true, matched: false });
    }

    const result = await dispatchTrigger(c.env, {
      workflow: resolved.workflow,
      trigger: resolved.trigger,
      event,
      context: { payload },
      source: "webhook",
    });
    await events.update(logId, {
      matchedWorkflowId: resolved.workflow.id,
      matchedTriggerId: resolved.trigger.id,
      dispatchedAction: result.outcome,
      agentSessionId: result.agentSessionId ?? null,
      error: result.error ?? null,
      eventSummary: `Generic webhook ${externalId}`,
      latencyMs: Date.now() - startedMs,
    });
    await new WebhookSourceStore(c.env.DB).touch(source.id);

    if (result.outcome === "error") {
      return c.json({ error: result.error ?? "dispatch_failed" }, 500);
    }
    if (result.outcome === "no_handler") {
      return c.json({ error: result.error ?? "no_handler" }, 422);
    }
    return c.json({ ok: true, session_id: result.agentSessionId }, 202);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await events.update(logId, {
      dispatchedAction: "error",
      error: msg,
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ error: "webhook_handler_error", message: msg }, 500);
  }
}

async function handleAgentSession(
  c: { env: Env; json: (b: unknown, s?: number) => Response },
  event: AgentSessionEventWebhook,
  logId: string,
  events: WebhookEventStore,
  startedMs: number,
): Promise<Response> {
  console.log("agent_session_event", event.action, event.agentSession.id);
  const dedupeKey = `webhook:${event.webhookId}:${event.agentSession.id}`;
  const seen = await c.env.LINEAR_TOKENS.get(dedupeKey);
  if (seen) {
    await events.update(logId, {
      deduped: true,
      dispatchedAction: "deduped",
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, deduped: true });
  }
  await c.env.LINEAR_TOKENS.put(dedupeKey, "1", {
    expirationTtl: WEBHOOK_DEDUPE_TTL_S,
  });

  if (event.action !== "created" && event.action !== "prompted") {
    await events.update(logId, {
      dispatchedAction: "ignored_envelope",
      eventSummary: `AgentSessionEvent ${event.action} (ignored)`,
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, ignored: true, action: event.action });
  }

  // Linear's `stop` signal arrives as a `prompted` action whose
  // underlying activity carries `signal: "stop"`. We handle the stop
  // path entirely from the webhook scope: Cloudflare's
  // WorkflowInstance.terminate() does NOT reliably run the workflow's
  // `finally` blocks, so cleanup (sandbox kill, final activity post,
  // DB status update) must happen here rather than inside the runner.
  if (event.action === "prompted" && extractStopSignal(event)) {
    return await handleStopSignal(c, event, logId, events, startedMs);
  }

  if (event.action === "prompted") {
    // Follow-up message inside an existing session. If the runner is
    // still alive (running or waiting for a follow-up event), forward
    // the webhook payload into the workflow via sendEvent so the
    // `step.waitForEvent` inside `runAgentSessionMode` unblocks and
    // queues another turn batch. If the runner already wrapped up
    // (complete / errored / terminated / never existed), spin up a
    // fresh instance with a `:rN` suffix so the user can keep talking
    // to us after the conversation closed.
    return await handlePromptedFollowUp(c, event, logId, events, startedMs);
  }

  // event.action === "created" — initial session start.
  try {
    await c.env.SESSION_RUNNER.create({
      id: event.agentSession.id,
      params: { mode: "agent_session", event },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/instance.*exists|already/i.test(msg)) {
      console.error("workflow_create_failed", msg);
      await events.update(logId, {
        dispatchedAction: "error",
        error: msg,
        latencyMs: Date.now() - startedMs,
      });
      throw e;
    }
    console.log("workflow_already_exists", event.agentSession.id);
  }

  await events.update(logId, {
    dispatchedAction: "start_session",
    agentSessionId: event.agentSession.id,
    eventSummary: `AgentSessionEvent ${event.action}`,
    latencyMs: Date.now() - startedMs,
  });
  return c.json({ ok: true, scheduled: true });
}

/**
 * Forward a `prompted` follow-up to a running SessionRunner instance,
 * or spin up a fresh instance if the previous one has already wrapped
 * up. Returns the webhook response unchanged shape-wise.
 */
async function handlePromptedFollowUp(
  c: { env: Env; json: (b: unknown, s?: number) => Response },
  event: AgentSessionEventWebhook,
  logId: string,
  events: WebhookEventStore,
  startedMs: number,
): Promise<Response> {
  const sessionId = event.agentSession.id;

  // Try to find the live instance. `Workflow.get(id)` rejects if no
  // instance exists with that id — we treat that as "session has
  // never run or has long since been GC'd" and spin up a fresh one.
  let liveStatus: string | null = null;
  let instance: Awaited<ReturnType<Workflow["get"]>> | null = null;
  try {
    instance = await c.env.SESSION_RUNNER.get(sessionId);
    const status = await instance.status();
    liveStatus = status.status;
  } catch (e) {
    console.log(
      "session_runner_instance_missing",
      sessionId,
      e instanceof Error ? e.message : String(e),
    );
  }

  if (
    instance &&
    (liveStatus === "running" || liveStatus === "waiting")
  ) {
    try {
      await instance.sendEvent({ type: "linear.prompted", payload: event });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("session_runner_send_event_failed", sessionId, msg);
      await events.update(logId, {
        dispatchedAction: "error",
        error: msg,
        latencyMs: Date.now() - startedMs,
      });
      throw e;
    }
    await events.update(logId, {
      dispatchedAction: "forwarded_to_running_instance",
      agentSessionId: sessionId,
      eventSummary: `AgentSessionEvent prompted (forwarded)`,
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, forwarded: true });
  }

  // No live instance — kick off a fresh one with a derived id so the
  // user can keep the conversation going after the runner has wrapped
  // up. The `:rN` suffix is monotonic per-millisecond so repeated
  // restarts don't collide.
  const resumeId = `${sessionId}:r${Date.now()}`;
  try {
    await c.env.SESSION_RUNNER.create({
      id: resumeId,
      params: { mode: "agent_session", event },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/instance.*exists|already/i.test(msg)) {
      console.error("workflow_create_failed_resume", msg);
      await events.update(logId, {
        dispatchedAction: "error",
        error: msg,
        latencyMs: Date.now() - startedMs,
      });
      throw e;
    }
    console.log("workflow_resume_already_exists", resumeId);
  }
  await events.update(logId, {
    dispatchedAction: "start_session_resume",
    agentSessionId: sessionId,
    eventSummary: `AgentSessionEvent prompted (resume, prior status=${liveStatus ?? "missing"})`,
    latencyMs: Date.now() - startedMs,
  });
  return c.json({ ok: true, scheduled: true, resume_id: resumeId });
}

/**
 * Handle Linear's `stop` signal: terminate the running workflow
 * instance, kill the sandbox, post a final `response` activity, and
 * mark the agent_sessions row stopped. All cleanup happens here
 * because Cloudflare doesn't guarantee `finally` runs after a
 * `terminate()`.
 */
async function handleStopSignal(
  c: { env: Env; json: (b: unknown, s?: number) => Response },
  event: AgentSessionEventWebhook,
  logId: string,
  events: WebhookEventStore,
  startedMs: number,
): Promise<Response> {
  const sessionId = event.agentSession.id;
  console.log("stop_signal_received", sessionId);

  // 1. Terminate the workflow instance if it's still alive.
  try {
    const instance = await c.env.SESSION_RUNNER.get(sessionId);
    const status = await instance.status();
    if (status.status === "running" || status.status === "waiting") {
      try {
        await instance.terminate();
      } catch (e) {
        // terminate() throws if the instance is already
        // complete/errored/terminated; ignore — we still want to do
        // the rest of the cleanup.
        console.log(
          "stop_signal_terminate_noop",
          sessionId,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  } catch (e) {
    console.log(
      "stop_signal_no_instance",
      sessionId,
      e instanceof Error ? e.message : String(e),
    );
  }

  // 2. Tear down the dispatcher's per-run sandbox so a hung pi
  //    process doesn't keep burning CPU after we tell the user we
  //    stopped. Mirrors `stopSandboxQuiet` in the workflow. The
  //    dispatcher keys the sandbox by the run id (= session id), so
  //    stop by `sessionId`, not the issue identifier.
  try {
    const dispatcher = new DispatcherClient(
      c.env.DISPATCHER_URL,
      c.env.DISPATCH_HMAC_SECRET,
    );
    await dispatcher.stop(sessionId);
  } catch (e) {
    console.error(
      "stop_signal_dispatcher_stop_failed",
      sessionId,
      e instanceof Error ? e.message : String(e),
    );
  }

  // 3. Resolve the install token + post a final `response` activity
  //    so the Linear session timeline shows we acknowledged the stop.
  if (event.organizationId) {
    try {
      const install = await new LinearAgentInstallStore(
        c.env.DB,
      ).getByLinearOrgId(event.organizationId);
      if (install?.access_token) {
        // Best-effort refresh closure: if Linear rotated the token
        // since we last persisted, the activity post will 401 and the
        // helper will fetch a fresh one through this callback.
        const orgId = install.organization_id;
        const refreshLinearToken = async () => {
          const r = await refreshInstallToken(c.env, orgId);
          return r?.accessToken ?? null;
        };
        const linear = buildActivityClient(
          install.access_token,
          refreshLinearToken,
        );
        await postResponse(
          linear,
          sessionId,
          "Stopped at user request.",
        );
      } else {
        console.warn(
          "stop_signal_no_install_token",
          event.organizationId,
        );
      }
    } catch (e) {
      console.error(
        "stop_signal_post_response_failed",
        sessionId,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // 4. Mark the agent_sessions row as stopped so the dashboard
  //    reflects user-driven disengagement vs natural completion.
  try {
    await new AgentSessionStore(c.env.DB).update(sessionId, {
      status: "stopped",
      completedAt: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    console.error(
      "stop_signal_session_update_failed",
      sessionId,
      e instanceof Error ? e.message : String(e),
    );
  }

  await events.update(logId, {
    dispatchedAction: "stopped_by_signal",
    agentSessionId: sessionId,
    eventSummary: "AgentSessionEvent prompted (stop signal)",
    latencyMs: Date.now() - startedMs,
  });
  return c.json({ ok: true, stopped: true });
}

/**
 * Extract the `signal` field off an incoming `prompted` webhook.
 *
 * Linear sends the user's new activity as part of the prompted event,
 * but the exact JSON path is not pinned in our typed envelope today.
 * Mirroring the Elixir-side `webhook_dispatcher.ex#extract_signal/1`
 * we probe three locations in priority order:
 *
 *   1. `event.agentActivity.signal`
 *   2. `event.data.agentActivity.signal` (some Linear webhooks wrap
 *      the activity under `data`)
 *   3. `event.signal` (top-level fallback)
 *
 * TODO: once we have a captured live `prompted` webhook fixture with
 * a stop signal, narrow this to the single observed path and add
 * the field to the typed `AgentSessionEventWebhook` envelope.
 */
function extractStopSignal(event: AgentSessionEventWebhook): boolean {
  const e = event as unknown as Record<string, unknown>;
  const fromNested = (
    parent: Record<string, unknown> | undefined,
  ): string | undefined => {
    if (!parent || typeof parent !== "object") return undefined;
    const activity = parent.agentActivity as
      | Record<string, unknown>
      | undefined;
    if (!activity || typeof activity !== "object") return undefined;
    const sig = activity.signal;
    return typeof sig === "string" ? sig : undefined;
  };
  const fromAgentActivity = fromNested(e);
  const fromData = fromNested(e.data as Record<string, unknown> | undefined);
  const topLevel = typeof e.signal === "string" ? (e.signal as string) : undefined;
  const signal = fromAgentActivity ?? fromData ?? topLevel;
  return signal === "stop";
}

async function handleGitHubSource(
  c: { env: Env; req: { raw: Request; header: (name: string) => string | undefined }; json: (b: unknown, s?: number) => Response },
  source: WebhookSourceRecord,
  events: WebhookEventStore,
  receivedAt: number,
  startedMs: number,
): Promise<Response> {
  const raw = await c.req.raw.clone().text();
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? null;
  const eventName = c.req.header("X-GitHub-Event") ?? "unknown";
  const action = parseGitHubAction(raw);

  const sigOk = await verifyGitHubSignature(
    source.secret,
    raw,
    c.req.header("X-Hub-Signature-256"),
  );
  const logId = await events.insert({
    receivedAt,
    organizationId: source.organization_id,
    sourceId: source.id,
    webhookId: deliveryId,
    envelopeType: `github.${eventName}`,
    envelopeAction: action,
    signatureOk: sigOk,
    rawBody: raw.slice(0, 65_536),
  });

  if (!sigOk) {
    await events.update(logId, {
      dispatchedAction: "error",
      error: "invalid_signature",
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ error: "invalid_signature" }, 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await events.update(logId, {
      dispatchedAction: "error",
      error: "invalid_json",
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ error: "invalid_json" }, 400);
  }

  return await dispatchGitHubEvent(c, {
    events,
    logId,
    organizationId: source.organization_id,
    eventName,
    action,
    payload: parsed,
    deliveryId,
    dedupeScope: `source:${source.id}`,
    rawLength: raw.length,
    startedMs,
  });
}

/**
 * App-level GitHub webhook receiver (`POST /webhook/github`).
 *
 * Unlike `/webhook/source/:id` — where the source row pins one tenant —
 * a GitHub App exposes a single webhook URL shared by every
 * installation. Signatures are verified against the one App-level
 * `GITHUB_APP_WEBHOOK_SECRET`, and the tenant org is resolved per
 * delivery from the payload's `installation.id` via `github_installs`.
 */
async function handleGitHubAppWebhook(
  c: {
    env: Env;
    req: { raw: Request; header: (name: string) => string | undefined };
    json: (b: unknown, s?: number) => Response;
  },
  events: WebhookEventStore,
  receivedAt: number,
  startedMs: number,
): Promise<Response> {
  const raw = await c.req.raw.clone().text();
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? null;
  const eventName = c.req.header("X-GitHub-Event") ?? "unknown";
  const action = parseGitHubAction(raw);

  const secret = c.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) {
    const logId = await events.insert({
      receivedAt,
      webhookId: deliveryId,
      envelopeType: `github.${eventName}`,
      envelopeAction: action,
      signatureOk: false,
      rawBody: raw.slice(0, 65_536),
    });
    await events.update(logId, {
      dispatchedAction: "error",
      error: "github_webhook_not_configured",
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ error: "github_webhook_not_configured" }, 503);
  }

  const sigOk = await verifyGitHubSignature(
    secret,
    raw,
    c.req.header("X-Hub-Signature-256"),
  );
  const logId = await events.insert({
    receivedAt,
    webhookId: deliveryId,
    envelopeType: `github.${eventName}`,
    envelopeAction: action,
    signatureOk: sigOk,
    rawBody: raw.slice(0, 65_536),
  });

  if (!sigOk) {
    await events.update(logId, {
      dispatchedAction: "error",
      error: "invalid_signature",
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ error: "invalid_signature" }, 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await events.update(logId, {
      dispatchedAction: "error",
      error: "invalid_json",
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ error: "invalid_json" }, 400);
  }

  // Resolve the tenant org from the installation. Events with no
  // installation context — notably the `ping` GitHub sends when the
  // webhook is first saved — are acknowledged without dispatch.
  const installId = extractGitHubInstallationId(parsed);
  if (installId == null) {
    await events.update(logId, {
      dispatchedAction: "ignored_envelope",
      eventSummary: `GitHub ${eventName} (no installation)`,
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, ignored: true });
  }

  const install = await new GitHubInstallStore(c.env.DB).getByInstallId(
    installId,
  );
  if (!install) {
    await events.update(logId, {
      dispatchedAction: "no_match",
      error: "no_install_for_github_installation",
      eventSummary: `GitHub installation ${installId} not registered`,
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, ignored: true });
  }

  return await dispatchGitHubEvent(c, {
    events,
    logId,
    organizationId: install.organization_id,
    eventName,
    action,
    payload: parsed,
    deliveryId,
    dedupeScope: "github",
    rawLength: raw.length,
    startedMs,
  });
}

/**
 * Shared tail for both GitHub webhook routes: normalize the payload to
 * an EventTuple, dedupe the delivery, resolve a workflow trigger, and
 * dispatch. The caller has already verified the signature and resolved
 * the tenant `organizationId`.
 */
async function dispatchGitHubEvent(
  c: { env: Env; json: (b: unknown, s?: number) => Response },
  args: {
    events: WebhookEventStore;
    logId: string;
    organizationId: string;
    eventName: string;
    action: string | null;
    payload: unknown;
    deliveryId: string | null;
    dedupeScope: string;
    rawLength: number;
    startedMs: number;
  },
): Promise<Response> {
  const {
    events,
    logId,
    organizationId,
    eventName,
    action,
    payload,
    deliveryId,
    dedupeScope,
    rawLength,
    startedMs,
  } = args;

  const mapped = normalizeGitHubSourceEvent({
    eventName,
    payload,
    organizationId,
    deliveryId,
  });
  if (!mapped) {
    await events.update(logId, {
      organizationId,
      dispatchedAction: "ignored_envelope",
      eventSummary: `GitHub ${eventName} ${action ?? "unknown"} (no handler)`,
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, ignored: true });
  }

  const dedupeKey = `webhook:${dedupeScope}:${deliveryId ?? rawLength}:${mapped.event.event_type}`;
  const seen = await c.env.LINEAR_TOKENS.get(dedupeKey);
  if (seen) {
    await events.update(logId, {
      organizationId,
      deduped: true,
      dispatchedAction: "deduped",
      eventSummary: mapped.summary,
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, deduped: true });
  }
  await c.env.LINEAR_TOKENS.put(dedupeKey, "1", {
    expirationTtl: WEBHOOK_DEDUPE_TTL_S,
  });

  const resolved = await resolveWorkflow(c.env, mapped.event);
  if (!resolved) {
    await events.update(logId, {
      organizationId,
      dispatchedAction: "no_match",
      eventSummary: mapped.summary,
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, matched: false });
  }

  const dispatched = await dispatchTrigger(c.env, {
    workflow: resolved.workflow,
    trigger: resolved.trigger,
    event: mapped.event,
    source: "webhook",
  });

  await events.update(logId, {
    organizationId,
    matchedWorkflowId: resolved.workflow.id,
    matchedTriggerId: resolved.trigger.id,
    dispatchedAction: dispatched.outcome,
    agentSessionId: dispatched.agentSessionId ?? null,
    error: dispatched.error ?? null,
    eventSummary: mapped.summary,
    latencyMs: Date.now() - startedMs,
  });

  return c.json({
    ok: true,
    matched: true,
    workflow_id: resolved.workflow.id,
    trigger_id: resolved.trigger.id,
    outcome: dispatched.outcome,
    agent_session_id: dispatched.agentSessionId ?? null,
  });
}

function parseGitHubAction(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { action?: unknown };
    return typeof parsed.action === "string" ? parsed.action : null;
  } catch {
    return null;
  }
}

function extractGitHubInstallationId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const inst = (payload as { installation?: unknown }).installation;
  if (!inst || typeof inst !== "object") return null;
  const id = (inst as { id?: unknown }).id;
  return typeof id === "number" ? id : null;
}

function normalizeGitHubSourceEvent(args: {
  eventName: string;
  payload: unknown;
  organizationId: string;
  deliveryId: string | null;
}) {
  if (args.eventName === "pull_request") {
    return normalizeGitHubPullRequestEvent({
      payload: args.payload as never,
      organizationId: args.organizationId,
      deliveryId: args.deliveryId,
    });
  }
  if (args.eventName === "issues") {
    return normalizeGitHubIssuesEvent({
      payload: args.payload as never,
      organizationId: args.organizationId,
      deliveryId: args.deliveryId,
    });
  }
  if (args.eventName === "issue_comment") {
    return normalizeGitHubIssueCommentEvent({
      payload: args.payload as never,
      organizationId: args.organizationId,
      deliveryId: args.deliveryId,
    });
  }
  return null;
}

async function handleIssueEnvelope(
  c: { env: Env; json: (b: unknown, s?: number) => Response },
  envelope: IssueWebhookEnvelope,
  ctx: {
    logId: string;
    orgId: string | null;
    envelopeAction: string | null;
    startedMs: number;
    events: WebhookEventStore;
  },
): Promise<Response> {
  const { logId, orgId, envelopeAction, startedMs, events } = ctx;

  if (!orgId) {
    await events.update(logId, {
      dispatchedAction: "no_match",
      error: "no_install_for_linear_org",
      latencyMs: Date.now() - startedMs,
      eventSummary: "Issue: no install for org",
    });
    return c.json({ ok: true, ignored: true });
  }

  // Filter envelopes we don't process at all (e.g. `remove`). Both
  // `create` and `update` go to the mapper — `create` fires
  // state_entered when the new issue lands in a non-default state
  // that matches a trigger's `to_state`. The mapper still returns
  // null for non-state-changing updates (e.g. title edits).
  if (envelopeAction !== "update" && envelopeAction !== "create") {
    await events.update(logId, {
      organizationId: orgId,
      dispatchedAction: "ignored_envelope",
      eventSummary: `Issue ${envelopeAction} (no handler)`,
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, ignored: true });
  }

  const mapped = mapIssueUpdateToEvent(envelope, orgId);
  if (!mapped) {
    await events.update(logId, {
      organizationId: orgId,
      dispatchedAction: "ignored_envelope",
      eventSummary:
        envelopeAction === "create"
          ? "Issue created without state"
          : "Issue update without state transition",
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, ignored: true });
  }

  // Dedupe Linear retries of the *same delivery*. `webhookId` is the
  // webhook registration UUID (constant across every delivery), so
  // adding `webhookTimestamp` is what makes the key per-delivery: Linear
  // stamps the same timestamp on every retry, but a re-entry into the
  // same state gets a different one. Without the timestamp, distinct
  // (issue, state) transitions within the 60-min TTL collapsed.
  const newStateId =
    envelope.data?.stateId ?? envelope.data?.state?.id ?? "no-state";
  const dedupeKey = `webhook:issue:${envelope.webhookId ?? "?"}:${envelope.data?.id ?? "?"}:${newStateId}:${envelope.webhookTimestamp ?? "?"}`;
  const seen = await c.env.LINEAR_TOKENS.get(dedupeKey);
  if (seen) {
    await events.update(logId, {
      organizationId: orgId,
      deduped: true,
      dispatchedAction: "deduped",
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, deduped: true });
  }
  await c.env.LINEAR_TOKENS.put(dedupeKey, "1", {
    expirationTtl: WEBHOOK_DEDUPE_TTL_S,
  });

  // Lazy-seed the Engineering Default workflow on the org's first
  // webhook delivery. Idempotent — skips when any workflow exists for
  // the org. Errors are swallowed so a seed regression can't 500 a
  // real delivery.
  try {
    await ensureDefaultWorkflow(c.env, orgId);
  } catch (e) {
    console.error(
      "ensure_default_workflow_failed",
      e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    );
  }

  const resolved = await resolveWorkflow(c.env, mapped.event);
  if (!resolved) {
    await events.update(logId, {
      organizationId: orgId,
      dispatchedAction: "no_match",
      eventSummary: mapped.summary,
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, matched: false });
  }

  const linearOrgId = envelope.organizationId ?? null;
  if (!linearOrgId) {
    await events.update(logId, {
      organizationId: orgId,
      dispatchedAction: "error",
      error: "missing_linear_organization_id",
      eventSummary: mapped.summary,
      latencyMs: Date.now() - startedMs,
    });
    return c.json({ ok: true, error: "missing_linear_organization_id" });
  }

  const dispatched = await dispatchTrigger(c.env, {
    workflow: resolved.workflow,
    trigger: resolved.trigger,
    event: mapped.event,
    linearOrganizationId: linearOrgId,
  });

  await events.update(logId, {
    organizationId: orgId,
    matchedWorkflowId: resolved.workflow.id,
    matchedTriggerId: resolved.trigger.id,
    dispatchedAction: dispatched.outcome,
    agentSessionId: dispatched.agentSessionId ?? null,
    error: dispatched.error ?? null,
    eventSummary: mapped.summary,
    latencyMs: Date.now() - startedMs,
  });

  return c.json({
    ok: true,
    matched: true,
    workflow_id: resolved.workflow.id,
    trigger_id: resolved.trigger.id,
    outcome: dispatched.outcome,
    agent_session_id: dispatched.agentSessionId ?? null,
  });
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

function inferEnvelopeType(parsed: Record<string, unknown> | null): string {
  if (!parsed) return "unknown";
  const t = parsed.type;
  if (typeof t === "string" && t.length > 0) return t;
  return "unknown";
}
