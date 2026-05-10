/**
 * Cloudflare Workflow that drives a single Linear Agent Session
 * end-to-end. Replaces the `ctx.waitUntil(runSession(...))` shape so a
 * Worker eviction mid-dispatch resumes from the last completed step
 * instead of dropping the session silently.
 *
 * Steps (each `step.do` is independently checkpointed):
 *
 *   1. load-token            — read the install's access_token from KV.
 *   2. post-initial-thought  — meet Linear's 10s first-activity SLA.
 *   3. resolve-inputs        — decide repo + prompt; classify outcome.
 *   4. dispatch-run          — call sandbox-dispatcher /run (long).
 *   5. post-terminal         — final response/error to Linear.
 *
 * Item 2 of SYM-267 expands step 4 into a per-turn loop over a streamed
 * SSE response from the dispatcher. The webhook handler doesn't change
 * shape between item 1 and item 2 — it always just creates an instance
 * of this Workflow and returns 200.
 *
 * Idempotency: the webhook handler passes `id: agentSession.id` so a
 * Linear retry of the same delivery (or a `prompted` event arriving on
 * an already-running session) collides on the Workflow id and the
 * caller treats the collision as success. See routes/webhook.ts.
 */

import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";

import type { Env } from "../index";
import {
  buildActivityClient,
  postError,
  postResponse,
  postThought,
} from "../lib/activities";
import {
  DispatcherClient,
  DispatcherError,
  type RunResult,
} from "../lib/dispatcher";
import {
  resolvePrompt,
  resolveRepoUrl,
  summarizeStdout,
  truncate,
} from "../lib/session-helpers";
import type { AgentSessionEventWebhook } from "../types/agent-session";

export interface SessionRunnerParams {
  event: AgentSessionEventWebhook;
}

type ResolvedInputs =
  | { kind: "ok"; repoUrl: string; prompt: string }
  | { kind: "no_repo" }
  | { kind: "no_prompt" };

type DispatchOutcome =
  | { kind: "dispatch_ok"; result: RunResult }
  | { kind: "dispatch_error"; message: string };

export class SessionRunner extends WorkflowEntrypoint<Env, SessionRunnerParams> {
  override async run(
    event: WorkflowEvent<SessionRunnerParams>,
    step: WorkflowStep,
  ): Promise<{ status: string; exit_code?: number | null }> {
    const webhookEvent = event.payload.event;
    const sessionId = webhookEvent.agentSession.id;

    const token = await step.do("load-token", async () => {
      return (await this.env.LINEAR_TOKENS.get("access_token")) ?? null;
    });

    if (!token) {
      console.error(
        "no_access_token",
        JSON.stringify({ session_id: sessionId }),
      );
      return { status: "no_token" };
    }

    await step.do("post-initial-thought", async () => {
      const linear = buildActivityClient(token);
      await postThought(linear, sessionId, "Picked this up — working on it.");
    });

    const resolved: ResolvedInputs = await step.do(
      "resolve-inputs",
      async () => {
        const repoUrl = resolveRepoUrl(this.env, webhookEvent.agentSession);
        if (!repoUrl) return { kind: "no_repo" } as const;
        const prompt = resolvePrompt(webhookEvent);
        if (!prompt) return { kind: "no_prompt" } as const;
        return { kind: "ok", repoUrl, prompt } as const;
      },
    );

    if (resolved.kind === "no_repo") {
      await step.do("post-no-repo-error", async () => {
        const linear = buildActivityClient(token);
        await postError(
          linear,
          sessionId,
          "No repository is configured for this team. Add one in `PROJECT_MAPPINGS_JSON` or the project config.",
        );
      });
      return { status: "no_repo" };
    }

    if (resolved.kind === "no_prompt") {
      await step.do("post-no-prompt-error", async () => {
        const linear = buildActivityClient(token);
        await postError(
          linear,
          sessionId,
          "Couldn't find a prompt in the session payload (no promptContext, comment body, or issue description).",
        );
      });
      return { status: "no_prompt" };
    }

    const issueIdentifier =
      webhookEvent.agentSession.issue?.identifier ?? sessionId;

    // retries: 0 — re-running pi is expensive and not idempotent until
    // item 4 lands deterministic commits. An eviction during this step
    // still resumes (Workflows always replays the current step on
    // restart) — that risk is accepted for item 1 and item 2 will
    // checkpoint per turn instead of per dispatch.
    const outcome: DispatchOutcome = await step.do(
      "dispatch-run",
      { retries: { limit: 0, delay: "1 second", backoff: "constant" } },
      async () => {
        try {
          const dispatcher = new DispatcherClient(
            this.env.DISPATCHER_URL,
            this.env.DISPATCH_HMAC_SECRET,
          );
          const result = await dispatcher.run({
            scope: this.env.DEFAULT_SCOPE,
            issueId: issueIdentifier,
            repoUrl: resolved.repoUrl,
            prompt: resolved.prompt,
            engine: (this.env.DEFAULT_ENGINE as "pi") ?? "pi",
            model: this.env.DEFAULT_MODEL || null,
          });
          return { kind: "dispatch_ok", result } as const;
        } catch (e) {
          const message =
            e instanceof DispatcherError
              ? `Dispatcher error (${e.status}): ${typeof e.body === "string" ? e.body : e.body.error}`
              : e instanceof Error
                ? e.message
                : "unknown_dispatcher_error";
          return { kind: "dispatch_error", message } as const;
        }
      },
    );

    await step.do("post-terminal-activity", async () => {
      const linear = buildActivityClient(token);
      if (outcome.kind === "dispatch_error") {
        await postError(linear, sessionId, outcome.message);
        return;
      }
      const result = outcome.result;
      if (result.exit_code === 0) {
        await postResponse(
          linear,
          sessionId,
          summarizeStdout(result.stdout) ||
            `Run finished in ${(result.duration_ms / 1000).toFixed(1)}s.`,
        );
      } else {
        await postError(
          linear,
          sessionId,
          `Engine exited with code ${result.exit_code}.\n\n` +
            "```\n" +
            truncate(result.stderr || result.stdout, 2000) +
            "\n```",
        );
      }
    });

    return {
      status: outcome.kind === "dispatch_ok" ? "ok" : "error",
      exit_code:
        outcome.kind === "dispatch_ok" ? outcome.result.exit_code : null,
    };
  }
}
