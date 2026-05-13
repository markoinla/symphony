/**
 * Cloudflare Workflow that drives a single Linear Agent Session
 * end-to-end. Each phase is checkpointed so a Worker eviction resumes
 * from the last completed step instead of dropping the session.
 *
 * Steps:
 *   1. load-token            — read the install's access_token from D1.
 *   2. post-initial-thought  — meet Linear's 10s first-activity SLA.
 *   3. resolve-inputs        — decide repo + prompt; classify outcome.
 *   4. turn-N (loop)         — stream the dispatcher's SSE response,
 *                              post normalized events as Linear
 *                              activities live, capture the turn's
 *                              outcome (done/needs_continuation/error).
 *                              For pi, the loop runs exactly once.
 *   5. post-terminal-activity — final response/error to Linear.
 *
 * In-flight activity posts inside `turn-N` are not idempotent on
 * eviction: a step that gets evicted re-runs from the start, which
 * means already-posted activities will double-post. Workflows
 * evictions are rare in practice and the live-timeline UX win
 * outweighs the cost. Linear may dedupe identical-content activities;
 * we don't rely on it.
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
import { mintInstallationToken } from "../lib/github-app";
import { refreshInstallToken } from "../lib/install-token";
import {
  DispatcherClient,
  DispatcherError,
  type NormalizedEvent,
  type RunCredentials,
} from "../lib/dispatcher";
import { lastAssistantText, mapToActivity } from "../lib/event-mapper";
import { resolveLinearMcpToken } from "../lib/linear-token";
import { withLinearGraphqlReference } from "../lib/prompts/linear-graphql";
import { resolvePrompt, truncate } from "../lib/session-helpers";
import {
  AgentSessionStore,
  GitHubInstallStore,
  LinearAgentInstallStore,
  ProjectStore,
  SettingStore,
} from "../lib/store";
import type { AgentSessionEventWebhook } from "../types/agent-session";
import type { EventTuple } from "../schemas/event";
import type { Trigger } from "../schemas/trigger";
import type { Workflow } from "../schemas/workflow";

// Per-workflow overrides snapshot. Populated by `dispatch-trigger`
// when a workflow resolved before queueing the runner; absent on
// non-trigger runs (manual @-mention, dashboard rerun). The runner
// reads these first, falls back to settings('agent.default_*'),
// then to env.DEFAULT_*. Frozen at dispatch time — edits to the
// workflow row mid-run don't perturb in-flight sessions.
export interface WorkflowOverrides {
  engine?: string;
  // Omit `model` when the workflow row's model is NULL ("inherit").
  // A present value is always an explicit override; `null` should
  // never be sent.
  model?: string;
  max_turns?: number;
}

export type SessionRunnerParams =
  | {
      // @-mention / Linear AgentSessionEvent webhook flow.
      // The runner posts thoughts/responses/errors back into Linear's
      // session timeline. `mode` is optional for backwards compat with
      // any in-flight instances queued without it.
      //
      // SYM-295 trigger-initiated runs also queue this mode: the
      // dispatcher mints a Linear AgentSession first and synthesizes
      // the webhook envelope so the run appears in Linear's timeline
      // identically to a real @-mention. Those runs additionally
      // carry `workflow_overrides` so the resolved workflow's
      // engine/model/max_turns reach the runner.
      mode?: "agent_session";
      event: AgentSessionEventWebhook;
      workflow_overrides?: WorkflowOverrides;
    }
  | {
      // Headless trigger flow — no Linear-side AgentSession exists,
      // the runner just drives the dispatcher and writes results to
      // `agent_sessions`. Currently unused at the call site (the
      // SYM-295 trigger flow uses `agent_session` mode above with a
      // synthetic webhook). Kept on the type for future headless
      // workflows (e.g. cron-fired runs).
      mode: "trigger";
      sessionId: string;
      organizationId: string;
      workflow: Workflow;
      trigger: Trigger;
      event: EventTuple;
      repoUrl: string;
      prompt: string;
      engine: string;
      model: string | null;
      maxTurns: number;
      scope: string;
      issueIdentifier: string;
    };

// Per-workflow engine/model/max_turns overrides flow in via
// `workflow_overrides` on the agent_session params (populated by
// `dispatch-trigger.ts`). Org-level defaults come from the
// `settings` table; the worker-wide floor stays on env.DEFAULT_*.

type ResolvedInputs =
  | {
      kind: "ok";
      repoUrl: string;
      prompt: string;
      engine: "pi";
      model: string | null;
      maxTurns: number;
      scope: string;
    }
  | { kind: "no_repo" }
  | { kind: "no_prompt" };

interface TurnResult {
  exit_code: number;
  duration_ms: number;
  branch: string | null;
  pr_url: string | null;
}

type TurnOutcome =
  | {
      kind: "done";
      result: TurnResult;
      lastAssistant: string | null;
      inbandError: string | null;
      eventSummary: EventSummaryItem[];
    }
  | {
      kind: "needs_continuation";
      result: TurnResult;
      lastAssistant: string | null;
      eventSummary: EventSummaryItem[];
    }
  | { kind: "dispatch_error"; message: string };

interface EventSummaryItem {
  type: string;
  timestamp: string;
  body?: string;
}

const DEFAULT_MAX_TURNS = 10;
const STDERR_TRUNCATE = 2000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class SessionRunner extends WorkflowEntrypoint<Env, SessionRunnerParams> {
  override async run(
    event: WorkflowEvent<SessionRunnerParams>,
    step: WorkflowStep,
  ): Promise<{
    status: string;
    exit_code?: number | null;
    turns?: number;
    pr_url?: string | null;
  }> {
    const params = event.payload;
    if (params.mode === "trigger") {
      return await this.runTriggerMode(params, step);
    }
    const webhookEvent = params.event;
    const sessionId = webhookEvent.agentSession.id;

    // Issue identifier is also the sandbox slug key on the dispatcher
    // side (`runSandboxId(issueId)`). Captured upfront so the cleanup
    // step in `finally` can always tear down the per-issue sandbox,
    // even if a step further down throws before `issueIdentifier`
    // would have been bound below.
    const cleanupIssueId =
      webhookEvent.agentSession.issue?.identifier ?? sessionId;

    try {
      return await this.runAgentSessionMode(
        params,
        webhookEvent,
        sessionId,
        step,
      );
    } finally {
      await this.stopSandboxQuiet(step, cleanupIssueId);
    }
  }

  /**
   * Best-effort sandbox teardown. Wrapped in a step so the call is
   * recorded in the workflow timeline (handy when debugging zombie
   * sandboxes) and swallows all errors — never fail a finally.
   */
  private async stopSandboxQuiet(
    step: WorkflowStep,
    issueId: string,
  ): Promise<void> {
    try {
      await step.do("stop-sandbox", async () => {
        const dispatcher = new DispatcherClient(
          this.env.DISPATCHER_URL,
          this.env.DISPATCH_HMAC_SECRET,
        );
        try {
          await dispatcher.stop(issueId);
        } catch (e) {
          console.error(
            "stop_sandbox_failed",
            JSON.stringify({
              issue_id: issueId,
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      });
    } catch (e) {
      // step.do itself can throw (Workflows internal error / eviction).
      // Don't escalate — the finally must never mask the original
      // error and must never replace a clean return with a throw.
      console.error(
        "stop_sandbox_step_failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  private async runAgentSessionMode(
    params: Extract<SessionRunnerParams, { event: AgentSessionEventWebhook }>,
    webhookEvent: AgentSessionEventWebhook,
    sessionId: string,
    step: WorkflowStep,
  ): Promise<{
    status: string;
    exit_code?: number | null;
    turns?: number;
    pr_url?: string | null;
  }> {
    const workflowOverrides = params.workflow_overrides;
    const installInfo = await step.do("load-token", async () => {
      const linearOrgId = webhookEvent.organizationId;
      if (!linearOrgId) return null;

      const installs = new LinearAgentInstallStore(this.env.DB);
      const install = await installs.getByLinearOrgId(linearOrgId);
      if (!install) return null;

      // Proactively refresh the install access_token. Linear's tokens
      // expire (typically within a day) and we have no `expires_at`
      // tracking on the install row, so a stale token would otherwise
      // 401 inside `post-initial-thought` and silently retry forever.
      const refreshed = await refreshInstallToken(
        this.env,
        install.organization_id,
      );
      const accessToken = refreshed?.accessToken ?? install.access_token;

      const github = await new GitHubInstallStore(this.env.DB).getByOrgId(
        install.organization_id,
      );
      return {
        token: accessToken,
        organizationId: install.organization_id,
        githubAppInstallationId: github?.install_id ?? null,
      };
    });

    if (!installInfo) {
      console.error(
        "no_access_token",
        JSON.stringify({ session_id: sessionId }),
      );
      return { status: "no_token" };
    }

    const token = installInfo.token;
    const organizationId = installInfo.organizationId;
    const githubAppInstallationId = installInfo.githubAppInstallationId;

    await step.do("post-initial-thought", async () => {
      const linear = buildActivityClient(token);
      await postThought(
        linear,
        sessionId,
        "Picked this up — preparing the sandbox. Cold-starts can take ~30–60s before tool activity begins streaming.",
      );
    });

    const resolved: ResolvedInputs = await step.do(
      "resolve-inputs",
      async () => {
        const teamId =
          webhookEvent.agentSession.issue?.teamId ??
          webhookEvent.agentSession.issue?.team?.id ??
          null;

        const projects = new ProjectStore(this.env.DB);
        const projectRow = teamId
          ? await projects.getByTeamId(organizationId, teamId)
          : null;

        // Repo always comes from the project row. Workflow-trigger-
        // initiated runs reach this same code path (their synthetic
        // webhook carries the rendered prompt inside `promptContext`),
        // so the team's project row must exist.
        const repoUrl = projectRow?.repo_url ?? null;
        if (!repoUrl) return { kind: "no_repo" } as const;

        // `resolvePrompt` reads `agentSession.promptContext` /
        // `event.promptContext` / comment body / issue description in
        // priority order. For trigger-initiated runs the dispatcher
        // pre-renders the workflow's Liquid template and stuffs it
        // into `promptContext`, so this picks it up verbatim.
        const rawPrompt = resolvePrompt(webhookEvent);
        if (!rawPrompt) return { kind: "no_prompt" } as const;
        // Point the engine at the `linear` skill and stamp the
        // per-session UUIDs onto the prompt. The skill (baked into the
        // sandbox baseline) wraps Linear's GraphQL API and reads its
        // bearer from the `LINEAR_API_TOKEN` env injected by the
        // dispatcher; the issue/team UUIDs from the webhook are the
        // arguments the skill needs. Continuation prompts embed
        // `resolved.prompt` verbatim, so they inherit this for free.
        const prompt = withLinearGraphqlReference(rawPrompt, {
          issueId: webhookEvent.agentSession.issue?.id ?? null,
          issueIdentifier: webhookEvent.agentSession.issue?.identifier ?? null,
          teamId: teamId,
        });

        // Resolution chain for engine / model / max_turns:
        //   1. workflow_overrides (snapshot of resolved workflow row,
        //      populated by dispatch-trigger when a trigger fired)
        //   2. settings('agent.default_*') — org-level defaults from
        //      the Agent settings page
        //   3. env.DEFAULT_* — worker-wide floor from wrangler.jsonc
        //   4. baked-in default
        //
        // projects.{engine,model,max_turns} are no longer consulted;
        // the columns stay in the schema for compat but the runner
        // ignores them. See SettingStore + the dashboard's Agent
        // settings tab.
        const settingStore = new SettingStore(this.env.DB);
        const orgSettings = await settingStore.list(organizationId);
        const settingByKey = new Map(orgSettings.map((s) => [s.key, s.value]));

        const engineFromSettings = settingByKey.get("agent.default_engine");
        const engine =
          workflowOverrides?.engine ??
          engineFromSettings ??
          this.env.DEFAULT_ENGINE ??
          "pi";

        // Model is the only field with NULL-means-inherit semantics
        // at the workflow level. dispatch-trigger omits `model` from
        // workflow_overrides when workflow.model is NULL, so any
        // truthy value here is an explicit override.
        const modelFromSettings = settingByKey.get("agent.default_model");
        const model =
          workflowOverrides?.model ??
          modelFromSettings ??
          (this.env.DEFAULT_MODEL || null);

        const maxTurnsFromSettings = settingByKey.get("agent.max_turns");
        const maxTurns =
          workflowOverrides?.max_turns ??
          (maxTurnsFromSettings
            ? parseMaxTurns(maxTurnsFromSettings)
            : parseMaxTurns(this.env.DEFAULT_MAX_TURNS));

        // Scope still comes from the project row (not part of the
        // engine/model/max_turns precedence migration). Sandbox
        // namespacing is per-team by design.
        const scope =
          projectRow?.scope ?? this.env.DEFAULT_SCOPE ?? "default";

        // sandbox-dispatcher only supports `pi` end-to-end today.
        // The settings API validator enforces this for org-level
        // defaults; non-pi values can still arrive via
        // `workflow_overrides` (workflow editor accepts codex /
        // claude-code) so we coerce here. When the dispatcher gains
        // additional adapters, broaden the ResolvedInputs union.
        if (engine !== "pi") {
          console.warn(
            "engine_coerced_to_pi",
            JSON.stringify({ requested: engine, session_id: sessionId }),
          );
        }
        return {
          kind: "ok",
          repoUrl,
          prompt,
          engine: "pi",
          model,
          maxTurns,
          scope,
        } as const;
      },
    );

    if (resolved.kind === "no_repo") {
      await step.do("post-no-repo-error", async () => {
        await postError(
          buildActivityClient(token),
          sessionId,
          "No repository is configured for this team. Add a project row via the admin API or dashboard.",
        );
      });
      return { status: "no_repo" };
    }

    if (resolved.kind === "no_prompt") {
      await step.do("post-no-prompt-error", async () => {
        await postError(
          buildActivityClient(token),
          sessionId,
          "Couldn't find a prompt in the session payload (no promptContext, comment body, or issue description).",
        );
      });
      return { status: "no_prompt" };
    }

    const issueIdentifier =
      webhookEvent.agentSession.issue?.identifier ?? sessionId;
    const issueGraphqlId = webhookEvent.agentSession.issue?.id ?? null;
    const maxTurns = resolved.maxTurns;

    // SYM-269: mint a per-org GitHub installation token if the org has
    // installed the Symphony GitHub App. Falls back to env.GITHUB_TOKEN.
    const githubToken: string | null = await step.do(
      "mint-github-token",
      async () => {
        if (
          githubAppInstallationId &&
          this.env.GITHUB_APP_ID &&
          this.env.GITHUB_APP_PRIVATE_KEY
        ) {
          try {
            return await mintInstallationToken(
              githubAppInstallationId,
              this.env.GITHUB_APP_ID,
              this.env.GITHUB_APP_PRIVATE_KEY,
            );
          } catch (e) {
            console.error(
              "github_app_token_mint_failed",
              e instanceof Error ? e.message : String(e),
            );
          }
        }
        return this.env.GITHUB_TOKEN ?? null;
      },
    );

    await step.do("record-session-start", async () => {
      try {
        await new AgentSessionStore(this.env.DB).create({
          id: sessionId,
          organizationId,
          linearIssueId: issueGraphqlId,
          linearIssueTitle:
            webhookEvent.agentSession.issue?.title ?? null,
          status: "running",
          triggeredBy: webhookEvent.action,
          team:
            webhookEvent.agentSession.issue?.team?.key ??
            webhookEvent.agentSession.issue?.teamId ??
            null,
          repo: resolved.repoUrl,
          prompt: resolved.prompt,
          configSnapshot: {
            model: resolved.model,
            max_turns: resolved.maxTurns,
            engine: resolved.engine,
          },
        });
      } catch (e) {
        console.error(
          "session_record_start_failed",
          e instanceof Error ? e.message : String(e),
        );
      }
    });

    let prompt = resolved.prompt;
    let lastAssistant: string | null = null;
    let terminal: TurnOutcome | null = null;
    let turnsRun = 0;
    const allEventSummaries: EventSummaryItem[] = [];

    for (let turn = 1; turn <= maxTurns; turn++) {
      turnsRun = turn;
      const turnLabel = `turn-${turn}`;
      const captured = prompt;

      // Resolve a fresh Linear OAuth token before each /run so
      // multi-turn sessions never dispatch with an expired credential.
      //
      // Preference order:
      //   1. Per-user Linear OAuth from `accounts` (acts as that human).
      //   2. The install's app-scoped access_token (acts as the
      //      Symphony Linear Agent install). Required for trigger-
      //      initiated runs where no human user is associated and for
      //      orgs that haven't completed the per-user link flow yet —
      //      otherwise the engine launches without any Linear auth and
      //      can't call the GraphQL API the prompt directs it to use.
      //
      // The token is delivered to the sandbox as the `LINEAR_API_TOKEN`
      // env var (dispatcher maps `linear_token` → that env). The Linear
      // MCP is no longer attached; the engine calls
      // https://api.linear.app/graphql directly via curl using the
      // cheatsheet baked into the prompt.
      const linearMcpCredentials: RunCredentials | null = await step.do(
        `resolve-linear-mcp-token-${turn}`,
        async () => {
          const result = await resolveLinearMcpToken({
            env: this.env,
            organizationId,
            triggeringUserId:
              webhookEvent.agentSession.comment?.userId ?? null,
            runTimeoutMs: DEFAULT_TIMEOUT_MS,
          });
          const linearToken = result?.accessToken ?? token;
          if (!linearToken) return null;
          return { linear_token: linearToken } as RunCredentials;
        },
      );

      const outcome: TurnOutcome = await step.do(
        turnLabel,
        { retries: { limit: 0, delay: "1 second", backoff: "constant" } },
        async () =>
          runTurn(this.env, sessionId, token, {
            scope: resolved.scope,
            issueId: issueIdentifier,
            repoUrl: resolved.repoUrl,
            prompt: captured,
            engine: resolved.engine,
            model: resolved.model,
            githubToken,
            credentials: linearMcpCredentials,
            turn,
          }),
      );

      if (outcome.kind === "dispatch_error") {
        terminal = outcome;
        break;
      }
      allEventSummaries.push(...outcome.eventSummary);
      if (outcome.lastAssistant) lastAssistant = outcome.lastAssistant;

      if (outcome.kind === "done") {
        terminal = outcome;
        break;
      }

      // needs_continuation
      if (turn >= maxTurns) {
        // Treat hitting max_turns as done (engine ran out of budget;
        // surface the last assistant message as the response).
        terminal = {
          kind: "done",
          result: outcome.result,
          lastAssistant: outcome.lastAssistant,
          inbandError: "max_turns_reached",
          eventSummary: [],
        };
        break;
      }

      // Build the next-turn prompt. Symphony's
      // `comment_watch.ex#continuation_section/1` is the reference;
      // for pi we only have the previous assistant message to weave
      // in (no Linear comment ingestion yet — that's item 7).
      prompt = buildContinuationPrompt(resolved.prompt, outcome.lastAssistant);
    }

    if (!terminal) {
      // Should be unreachable — the for-loop above always sets `terminal`
      // on completion or break. Defensive default for the type checker.
      terminal = {
        kind: "dispatch_error",
        message: "unreachable_no_terminal_outcome",
      };
    }

    await step.do("post-terminal-activity", async () => {
      const linear = buildActivityClient(token);
      if (terminal.kind === "dispatch_error") {
        await postError(linear, sessionId, terminal.message);
        return;
      }
      const result = terminal.result;
      if (result.exit_code === 0 && !terminal.inbandError) {
        const summary =
          lastAssistant ||
          `Run finished in ${(result.duration_ms / 1000).toFixed(1)}s.`;
        const withPr = summary;
        await postResponse(linear, sessionId, withPr);
      } else {
        const detail =
          terminal.inbandError ?? `engine exited with code ${result.exit_code}`;
        await postError(
          linear,
          sessionId,
          `Engine exited with code ${result.exit_code}.\n\n` +
            "```\n" +
            truncate(detail, STDERR_TRUNCATE) +
            "\n```",
        );
      }
    });

    await step.do("record-session-end", async () => {
      try {
        const finalStatus =
          terminal!.kind === "dispatch_error"
            ? "error"
            : terminal!.kind === "done" &&
                terminal!.result.exit_code === 0
              ? "completed"
              : "error";
        const errorMsg =
          terminal!.kind === "dispatch_error"
            ? terminal!.message
            : terminal!.kind === "done" && terminal!.inbandError
              ? terminal!.inbandError
              : null;
        await new AgentSessionStore(this.env.DB).update(sessionId, {
          status: finalStatus,
          completedAt: Math.floor(Date.now() / 1000),
          error: errorMsg,
          messages:
            allEventSummaries.length > 0
              ? JSON.stringify(allEventSummaries)
              : null,
        });
      } catch (e) {
        console.error(
          "session_record_end_failed",
          e instanceof Error ? e.message : String(e),
        );
      }
    });

    return {
      status: terminal.kind === "dispatch_error" ? "error" : "ok",
      exit_code:
        terminal.kind === "dispatch_error" ? null : terminal.result.exit_code,
      turns: turnsRun,
      pr_url: null,
    };
  }

  /**
   * Trigger-initiated flow (SYM-295). No Linear AgentSession exists,
   * so this path never calls into Linear's activity API. The session
   * row was already INSERTed by `dispatchTrigger`; we just drive the
   * dispatcher and write the terminal status back to D1.
   */
  private async runTriggerMode(
    params: Extract<SessionRunnerParams, { mode: "trigger" }>,
    step: WorkflowStep,
  ): Promise<{
    status: string;
    exit_code?: number | null;
    turns?: number;
    pr_url?: null;
  }> {
    try {
      return await this.runTriggerModeInner(params, step);
    } finally {
      await this.stopSandboxQuiet(step, params.issueIdentifier);
    }
  }

  private async runTriggerModeInner(
    params: Extract<SessionRunnerParams, { mode: "trigger" }>,
    step: WorkflowStep,
  ): Promise<{
    status: string;
    exit_code?: number | null;
    turns?: number;
    pr_url?: null;
  }> {
    const {
      sessionId,
      organizationId,
      repoUrl,
      model,
      maxTurns,
      scope,
      issueIdentifier,
    } = params;
    // Point the engine at the `linear` skill on every prompt so
    // headless runs (no synthesized webhook with promptContext) still
    // pick it up. Idempotent — withLinearGraphqlReference is a no-op
    // if the marker is already present in the prompt.
    //
    // Headless params don't carry the issue UUID today (mode currently
    // has no caller), so only the human identifier is plumbed through.
    // When a real trigger path needs Linear writes, extend the params
    // type to include `issueGraphqlId` and pass it here.
    const prompt = withLinearGraphqlReference(params.prompt, {
      issueIdentifier,
    });

    const githubAppInstallationId: number | null = await step.do(
      "trigger-load-github-install",
      async () => {
        const gh = await new GitHubInstallStore(this.env.DB).getByOrgId(
          organizationId,
        );
        return gh?.install_id ?? null;
      },
    );

    const githubToken: string | null = await step.do(
      "trigger-mint-github-token",
      async () => {
        if (
          githubAppInstallationId &&
          this.env.GITHUB_APP_ID &&
          this.env.GITHUB_APP_PRIVATE_KEY
        ) {
          try {
            return await mintInstallationToken(
              githubAppInstallationId,
              this.env.GITHUB_APP_ID,
              this.env.GITHUB_APP_PRIVATE_KEY,
            );
          } catch (e) {
            console.error(
              "github_app_token_mint_failed_trigger",
              e instanceof Error ? e.message : String(e),
            );
          }
        }
        return this.env.GITHUB_TOKEN ?? null;
      },
    );

    let currentPrompt = prompt;
    let lastAssistant: string | null = null;
    let terminal: TurnOutcome | null = null;
    let turnsRun = 0;
    const allEventSummaries: EventSummaryItem[] = [];

    for (let turn = 1; turn <= maxTurns; turn++) {
      turnsRun = turn;
      const captured = currentPrompt;

      const outcome: TurnOutcome = await step.do(
        `trigger-turn-${turn}`,
        { retries: { limit: 0, delay: "1 second", backoff: "constant" } },
        async () =>
          runTurnHeadless(this.env, {
            scope,
            issueId: issueIdentifier,
            repoUrl,
            prompt: captured,
            engine: "pi",
            model,
            githubToken,
            credentials: null,
            turn,
          }),
      );

      if (outcome.kind === "dispatch_error") {
        terminal = outcome;
        break;
      }
      allEventSummaries.push(...outcome.eventSummary);
      if (outcome.lastAssistant) lastAssistant = outcome.lastAssistant;

      if (outcome.kind === "done") {
        terminal = outcome;
        break;
      }

      if (turn >= maxTurns) {
        terminal = {
          kind: "done",
          result: outcome.result,
          lastAssistant: outcome.lastAssistant,
          inbandError: "max_turns_reached",
          eventSummary: [],
        };
        break;
      }

      currentPrompt = buildContinuationPrompt(prompt, outcome.lastAssistant);
    }

    if (!terminal) {
      terminal = {
        kind: "dispatch_error",
        message: "unreachable_no_terminal_outcome",
      };
    }

    await step.do("trigger-record-session-end", async () => {
      try {
        const finalStatus =
          terminal!.kind === "dispatch_error"
            ? "error"
            : terminal!.kind === "done" &&
                terminal!.result.exit_code === 0
              ? "completed"
              : "error";
        const errorMsg =
          terminal!.kind === "dispatch_error"
            ? terminal!.message
            : terminal!.kind === "done" && terminal!.inbandError
              ? terminal!.inbandError
              : null;
        await new AgentSessionStore(this.env.DB).update(sessionId, {
          status: finalStatus,
          completedAt: Math.floor(Date.now() / 1000),
          error: errorMsg,
          messages:
            allEventSummaries.length > 0
              ? JSON.stringify(allEventSummaries)
              : null,
        });
      } catch (e) {
        console.error(
          "trigger_session_record_end_failed",
          e instanceof Error ? e.message : String(e),
        );
      }
    });

    return {
      status: terminal.kind === "dispatch_error" ? "error" : "ok",
      exit_code:
        terminal.kind === "dispatch_error" ? null : terminal.result.exit_code,
      turns: turnsRun,
      pr_url: null,
    };
  }
}

/**
 * Run one turn: open the dispatcher SSE stream, map each normalized
 * event to a Linear activity, post live, capture the turn outcome.
 *
 * Exported only via the workflow's step body. Pulled out as a plain
 * function so unit tests can call it directly with an injected
 * dispatcher fetch.
 */
async function runTurn(
  env: Env,
  sessionId: string,
  token: string,
  args: {
    scope: string;
    issueId: string;
    repoUrl: string;
    prompt: string;
    engine: "pi";
    model: string | null;
    githubToken: string | null;
    credentials: RunCredentials | null;
    turn: number;
  },
): Promise<TurnOutcome> {
  const linear = buildActivityClient(token);
  const dispatcher = new DispatcherClient(
    env.DISPATCHER_URL,
    env.DISPATCH_HMAC_SECRET,
  );

  const events: NormalizedEvent[] = [];
  let result: TurnResult | null = null;
  let inbandError: string | null = null;
  let turnEndReason: "completed" | "needs_continuation" | "error" | null = null;

  try {
    for await (const ev of dispatcher.runStream({
      scope: args.scope,
      issueId: args.issueId,
      repoUrl: args.repoUrl,
      prompt: args.prompt,
      engine: args.engine,
      model: args.model,
      githubToken: args.githubToken,
      credentials: args.credentials,
    })) {
      events.push(ev);

      if (ev.type === "result") {
        result = {
          exit_code: ev.exit_code,
          duration_ms: ev.duration_ms,
          branch: ev.branch,
          pr_url: ev.pr_url,
        };
        continue;
      }
      if (ev.type === "turn_end") {
        turnEndReason = ev.reason;
        continue;
      }
      if (ev.type === "error") {
        inbandError = ev.message;
        // Error events also map to a Linear `error` activity below,
        // so users see them in the timeline live.
      }

      const activity = mapToActivity(ev);
      if (activity) {
        await safe(() =>
          linear.createAgentActivity({
            agentSessionId: sessionId,
            content: activity,
          }),
        );
      }
    }
  } catch (e) {
    const message =
      e instanceof DispatcherError
        ? `Dispatcher error (${e.status}): ${typeof e.body === "string" ? e.body : e.body.error}`
        : e instanceof Error
          ? e.message
          : "unknown_dispatcher_error";
    return { kind: "dispatch_error", message };
  }

  if (!result) {
    return {
      kind: "dispatch_error",
      message: "stream_closed_without_result_frame",
    };
  }

  const lastAssistant = lastAssistantText(events);
  const eventSummary = summarizeEvents(events);

  if (turnEndReason === "needs_continuation" && result.exit_code === 0) {
    return { kind: "needs_continuation", result, lastAssistant, eventSummary };
  }
  return { kind: "done", result, lastAssistant, inbandError, eventSummary };
}

/**
 * Headless turn — drives the dispatcher SSE stream like `runTurn` but
 * never posts back into Linear. Used by trigger-initiated sessions
 * which have no Linear AgentSession id to attach activities to.
 */
async function runTurnHeadless(
  env: Env,
  args: {
    scope: string;
    issueId: string;
    repoUrl: string;
    prompt: string;
    engine: "pi";
    model: string | null;
    githubToken: string | null;
    credentials: RunCredentials | null;
    turn: number;
  },
): Promise<TurnOutcome> {
  const dispatcher = new DispatcherClient(
    env.DISPATCHER_URL,
    env.DISPATCH_HMAC_SECRET,
  );

  const events: NormalizedEvent[] = [];
  let result: TurnResult | null = null;
  let inbandError: string | null = null;
  let turnEndReason: "completed" | "needs_continuation" | "error" | null = null;

  try {
    for await (const ev of dispatcher.runStream({
      scope: args.scope,
      issueId: args.issueId,
      repoUrl: args.repoUrl,
      prompt: args.prompt,
      engine: args.engine,
      model: args.model,
      githubToken: args.githubToken,
      credentials: args.credentials,
    })) {
      events.push(ev);
      if (ev.type === "result") {
        result = {
          exit_code: ev.exit_code,
          duration_ms: ev.duration_ms,
          branch: ev.branch,
          pr_url: ev.pr_url,
        };
        continue;
      }
      if (ev.type === "turn_end") {
        turnEndReason = ev.reason;
        continue;
      }
      if (ev.type === "error") {
        inbandError = ev.message;
      }
    }
  } catch (e) {
    const message =
      e instanceof DispatcherError
        ? `Dispatcher error (${e.status}): ${typeof e.body === "string" ? e.body : e.body.error}`
        : e instanceof Error
          ? e.message
          : "unknown_dispatcher_error";
    return { kind: "dispatch_error", message };
  }

  if (!result) {
    return {
      kind: "dispatch_error",
      message: "stream_closed_without_result_frame",
    };
  }

  const lastAssistant = lastAssistantText(events);
  const eventSummary = summarizeEvents(events);

  if (turnEndReason === "needs_continuation" && result.exit_code === 0) {
    return { kind: "needs_continuation", result, lastAssistant, eventSummary };
  }
  return { kind: "done", result, lastAssistant, inbandError, eventSummary };
}

function parseMaxTurns(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_TURNS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_TURNS;
  return Math.min(n, 100);
}

/**
 * Build the prompt for turn N+1 based on the previous turn's
 * assistant message. Mirrors Symphony's
 * `comment_watch.ex#continuation_section/1` shape, minus the Linear
 * comment ingestion (item 7) which doesn't exist on the Worker yet.
 */
function buildContinuationPrompt(
  originalPrompt: string,
  previousAssistant: string | null,
): string {
  const previous = previousAssistant
    ? `Previous turn's response:\n${previousAssistant}\n\n---\n`
    : "";
  return `${previous}Continuing the same task. Original request:\n\n${originalPrompt}`;
}

function summarizeEvents(events: NormalizedEvent[]): EventSummaryItem[] {
  const now = new Date().toISOString();
  return events
    .filter((e) => e.type !== "turn_end")
    .map((e) => {
      const item: EventSummaryItem = { type: e.type, timestamp: now };
      if (e.type === "thought" || e.type === "assistant_msg") {
        item.body = truncate(e.text, 500);
      } else if (e.type === "tool_call") {
        const argStr =
          typeof e.args === "string"
            ? e.args
            : JSON.stringify(e.args ?? "");
        item.body = `${e.tool}(${truncate(argStr, 200)})`;
      } else if (e.type === "tool_result") {
        item.body = truncate(e.result ?? (e.ok ? "ok" : "error"), 200);
      } else if (e.type === "error") {
        item.body = e.message;
      } else if (e.type === "result") {
        item.body = `exit_code=${e.exit_code}`;
      }
      return item;
    });
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error("activity_post_failed", e instanceof Error ? e.message : e);
  }
}
