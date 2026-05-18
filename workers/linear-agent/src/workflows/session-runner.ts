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
  postElicitation,
  postError,
  postResponse,
  postThought,
} from "../lib/activities";
import { resolveAgentViewerId } from "../lib/agent-viewer";
import { mintInstallationToken } from "../lib/github-app";
import {
  refreshInstallToken,
  refreshInstallTokenIfNeeded,
} from "../lib/install-token";
import type { LinearTokenRefresher } from "../lib/linear-graphql";
import {
  DispatcherClient,
  DispatcherError,
  RUN_TERMINAL_EVENT,
  deriveBranchFromIssueIdentifier,
  dispatchBranchForSubject,
  type NormalizedEvent,
  type RunCredentials,
  type RunTerminalPayload,
} from "../lib/dispatcher";
import { mapToActivity } from "../lib/event-mapper";
import {
  updateAgentSession,
  updateIssue,
} from "../lib/linear-mutations";
import { resolveLinearMcpToken } from "../lib/linear-token";
import { withLinearGraphqlReference } from "../lib/prompts/linear-graphql";
import { resolvePrompt, truncate } from "../lib/session-helpers";
import {
  AgentSessionEventStore,
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
  // Resolved workflow name, surfaced in the initial Linear thought.
  name?: string;
  engine?: string;
  // Omit `model` when the workflow row's model is NULL ("inherit").
  // A present value is always an explicit override; `null` should
  // never be sent.
  model?: string;
  thinking_level?: string;
  max_turns?: number;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  permission_mode?: string;
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
      thinkingLevel: string | null;
      maxTurns: number;
      scope: string;
      issueIdentifier: string;
    };

// Per-workflow engine/model/max_turns and dispatcher-supported policy
// overrides flow in via `workflow_overrides` on the agent_session
// params (populated by `dispatch-trigger.ts`). Org-level defaults come
// from the `settings` table; the worker-wide floor stays on
// env.DEFAULT_*.

type ResolvedInputs =
  | {
      kind: "ok";
      repoUrl: string;
      prompt: string;
      engine: string;
      model: string | null;
      thinkingLevel: string | null;
      maxTurns: number;
      scope: string;
      allowedTools: string[] | null;
      disallowedTools: string[] | null;
      permissionMode: string | null;
    }
  | { kind: "no_repo" }
  | { kind: "no_prompt" };

interface TurnResult {
  exit_code: number;
  duration_ms: number;
  branch: string | null;
  pr_url: string | null;
}

// TurnOutcome no longer carries a per-event summary array — the
// streaming turn writes each event into `agent_session_events` as it
// arrives. Keeping the step output small (just the result frame +
// lastAssistant) is what prevents Workflows' ~1 MiB step-output ceiling
// from killing a chatty turn.
type TurnOutcome =
  | {
      kind: "done";
      result: TurnResult;
      lastAssistant: string | null;
      inbandError: string | null;
    }
  | {
      kind: "needs_continuation";
      result: TurnResult;
      lastAssistant: string | null;
    }
  | { kind: "dispatch_error"; message: string };

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
      return await this.runTriggerMode(params, step, event.instanceId);
    }
    const webhookEvent = params.event;
    const sessionId = webhookEvent.agentSession.id;

    try {
      return await this.runAgentSessionMode(
        params,
        webhookEvent,
        sessionId,
        step,
        // The workflow instance id — equals `sessionId` for a normal
        // run, `<sessionId>:rN` for a prompted resume. The engine-push
        // ingest endpoint wakes this exact instance, so it is threaded
        // through to the dispatcher rather than assumed.
        event.instanceId,
      );
    } finally {
      // The dispatcher keys the sandbox by the run id (= session id),
      // so teardown always targets `sessionId`.
      await this.stopSandboxQuiet(step, sessionId);
    }
  }

  /**
   * Best-effort sandbox teardown. Wrapped in a step so the call is
   * recorded in the workflow timeline (handy when debugging zombie
   * sandboxes) and swallows all errors — never fail a finally.
   *
   * `runId` must be the same value the run dispatched with (the agent
   * session id); the dispatcher keys the sandbox by it.
   */
  private async stopSandboxQuiet(
    step: WorkflowStep,
    runId: string,
  ): Promise<void> {
    try {
      await step.do("stop-sandbox", async () => {
        const dispatcher = new DispatcherClient(
          this.env.DISPATCHER_URL,
          this.env.DISPATCH_HMAC_SECRET,
        );
        try {
          await dispatcher.stop(runId);
        } catch (e) {
          console.error(
            "stop_sandbox_failed",
            JSON.stringify({
              run_id: runId,
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
    instanceId: string,
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

      // Proactive refresh, but only when the stored expiry is inside
      // our run-timeout + safety window. Migration 0006 added
      // `expires_at`; legacy rows with null expiry are refreshed too
      // (treated as unknown). This skips Linear's `/oauth/token` on
      // every session start once the column is populated — important
      // because each call burns a refresh_token rotation.
      const refreshed = await refreshInstallTokenIfNeeded(
        this.env,
        install.organization_id,
        DEFAULT_TIMEOUT_MS,
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

    // `token` is mutated by the refresh closure so subsequent top-level
    // helper calls (updateIssue, updateAgentSession, …) pick up the
    // rotated token even though they take a plain string arg. Inside a
    // single helper, `linearGraphQL`'s 401 retry already refreshes on
    // demand; the latching here is for cross-helper reuse within one
    // workflow instance.
    let token = installInfo.token;
    const organizationId = installInfo.organizationId;
    const githubAppInstallationId = installInfo.githubAppInstallationId;

    // Refresh closure threaded into every Linear GraphQL helper used
    // below. Mirrors `SymphonyElixir.Linear.AgentAPI.handle_unauthorized`
    // (lib/symphony_elixir/linear/agent_api.ex:180) — on 401, fetch a
    // fresh token via the OAuth refresh flow, update the latched
    // `token`, and let the helper retry once.
    //
    // `refreshInstallToken` is single-flight per org-id within this
    // module's lifetime, so the dozens of activity posts that fire
    // off the dispatcher SSE stream in `runTurn` will collapse onto
    // one refresh call when the token expires mid-session.
    const refreshLinearToken: LinearTokenRefresher = async () => {
      const r = await refreshInstallToken(this.env, organizationId);
      if (r) token = r.accessToken;
      return r?.accessToken ?? null;
    };

    await step.do("post-initial-thought", async () => {
      const linear = buildActivityClient(token, refreshLinearToken);
      const workflowName = workflowOverrides?.name;
      await postThought(
        linear,
        sessionId,
        workflowName
          ? `Picked this up with workflow **${workflowName}**.`
          : "Picked this up.",
      );
    });

    // Side-effects that make the session look "owned" in Linear's UI:
    // set the agent as the issue's delegate, attach the dashboard link,
    // and post an initial 2-item plan. All best-effort — every failure
    // here is logged but never throws, since the actual run is the
    // real product and these are polish.
    //
    // State transitions are intentionally NOT done here — they belong
    // to the workflow prompt so each workflow can choose the right
    // moment to move the issue (e.g. Land PR moves to "In Progress"
    // only after gh pr checkout succeeds, Staged moves to "Human
    // Review" after pushing a PR).
    //
    // Only on `created` (the kickoff webhook). `prompted` follow-ups
    // must NOT stomp user-driven changes between turns.
    if (webhookEvent.action === "created") {
      await step.do("start-session-side-effects", async () => {
        const issueId = webhookEvent.agentSession.issue?.id ?? null;
        const linearOrgId = webhookEvent.organizationId ?? null;

        // Set the agent as the issue's delegate so the AgentSession
        // shows ownership in Linear's UI. Skip if we can't resolve the
        // agent viewer id.
        if (issueId) {
          try {
            const viewerId = linearOrgId
              ? await resolveAgentViewerId(
                  token,
                  linearOrgId,
                  this.env.LINEAR_TOKENS,
                  refreshLinearToken,
                )
              : null;

            if (viewerId) {
              await updateIssue(token, {
                issueId,
                delegateId: viewerId,
              }, refreshLinearToken).catch((e) => {
                console.error(
                  "issue_update_failed",
                  JSON.stringify({
                    session_id: sessionId,
                    issue_id: issueId,
                    error: e instanceof Error ? e.message : String(e),
                  }),
                );
              });
            }
          } catch (e) {
            console.error(
              "start_session_delegate_failed",
              e instanceof Error ? e.message : String(e),
            );
          }
        }

        // externalUrls — link the session header to our dashboard.
        // `env.URL` is the deployed origin (also reused for OAuth
        // callback). Skip silently when absent (e.g. local smoke runs
        // that didn't set the binding).
        const publicUrl = this.env.URL;
        if (publicUrl) {
          try {
            await updateAgentSession(token, {
              agentSessionId: sessionId,
              externalUrls: [
                {
                  label: "Open in Symphony",
                  url: `${publicUrl.replace(/\/$/, "")}/dashboard/sessions/${sessionId}`,
                },
              ],
            }, refreshLinearToken);
          } catch (e) {
            console.error(
              "agent_session_external_urls_failed",
              e instanceof Error ? e.message : String(e),
            );
          }
        } else {
          console.warn(
            "agent_session_external_urls_skipped_no_public_url",
            JSON.stringify({ session_id: sessionId }),
          );
        }

        // Initial plan — deliberately minimal. Finer-grained per-event
        // plan updates are out of scope; this is enough to give the
        // session timeline a visible structure.
        try {
          await updateAgentSession(token, {
            agentSessionId: sessionId,
            plan: [
              { content: "Preparing sandbox", status: "completed" },
              { content: "Running agent", status: "inProgress" },
            ],
          }, refreshLinearToken);
        } catch (e) {
          console.error(
            "agent_session_plan_init_failed",
            e instanceof Error ? e.message : String(e),
          );
        }
      });
    }

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
        const engine = normalizeEngineName(
          workflowOverrides?.engine ??
            engineFromSettings ??
            this.env.DEFAULT_ENGINE ??
            "pi",
        );

        // Model is the only field with NULL-means-inherit semantics
        // at the workflow level. dispatch-trigger omits `model` from
        // workflow_overrides when workflow.model is NULL, so any
        // truthy value here is an explicit override.
        const modelFromSettings = settingByKey.get("agent.default_model");
        const model =
          workflowOverrides?.model ??
          modelFromSettings ??
          (this.env.DEFAULT_MODEL || null);

        const thinkingLevelFromSettings = settingByKey.get("agent.thinking_level");
        const thinkingLevel =
          workflowOverrides?.thinking_level ??
          thinkingLevelFromSettings ??
          (this.env.DEFAULT_THINKING_LEVEL || null);

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

        return {
          kind: "ok",
          repoUrl,
          prompt,
          engine,
          model,
          thinkingLevel,
          maxTurns,
          scope,
          allowedTools: workflowOverrides?.allowed_tools ?? null,
          disallowedTools: workflowOverrides?.disallowed_tools ?? null,
          permissionMode: workflowOverrides?.permission_mode ?? null,
        } as const;
      },
    );

    if (resolved.kind === "no_repo") {
      // Recoverable: ask the user to set up a project, then re-mention.
      // Posted as `elicitation` (not `error`) so Linear renders it as
      // a conversational nudge the user can reply to in-thread.
      await step.do("post-no-repo-error", async () => {
        await postElicitation(
          buildActivityClient(token, refreshLinearToken),
          sessionId,
          "No repository is configured for this team yet. Add a project row in the Symphony dashboard (Projects tab), then re-mention me to retry.",
        );
      });
      return { status: "no_repo" };
    }

    if (resolved.kind === "no_prompt") {
      // Recoverable: the user can reply with a task or fill in the
      // issue description and re-mention. Elicitation, not error.
      await step.do("post-no-prompt-error", async () => {
        await postElicitation(
          buildActivityClient(token, refreshLinearToken),
          sessionId,
          "I didn't find a prompt in this session. Reply with the task you'd like me to do, or add a description to the issue and re-mention me.",
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
          linearIssueIdentifier:
            webhookEvent.agentSession.issue?.identifier ?? null,
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
            thinking_level: resolved.thinkingLevel,
            max_turns: resolved.maxTurns,
            engine: resolved.engine,
            allowed_tools: resolved.allowedTools,
            disallowed_tools: resolved.disallowedTools,
            permission_mode: resolved.permissionMode,
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
    // Initialize `terminal` to a sentinel error so that even if the
    // turn loop throws before the first runTurnBatch assignment (e.g.
    // step.do internal failure on `resolve-linear-mcp-token-*`), the
    // downstream try/catch sees a well-formed value and the
    // post-terminal-activity / record-session-end steps below have
    // something to serialize. This is the safety net that turns
    // WorkflowInternalError on any inner step into a clean error
    // terminal instead of a zombie session row.
    let terminal: TurnOutcome = {
      kind: "dispatch_error",
      message: "workflow_aborted_before_terminal_state",
    };
    let turnsRun = 0;

    /**
     * Run a batch of turns starting at `startTurn` until either the
     * engine reports `done`, a dispatch error occurs, or the global
     * `maxTurns` cap is hit. `turnsRun` is updated in-place. Always
     * normalizes `needs_continuation` at `maxTurns` to `done`, so the
     * return type excludes that variant.
     */
    type BatchTerminal = Exclude<TurnOutcome, { kind: "needs_continuation" }>;
    const runTurnBatch = async (startTurn: number): Promise<BatchTerminal> => {
      let batchTerminal: BatchTerminal | null = null;
      for (let turn = startTurn; turn <= maxTurns; turn++) {
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

        // pi runs its whole agentic loop in one invocation and pushes
        // events straight to this worker's ingest endpoint — there is
        // no SSE turn to stream. Start the run, then park on the
        // terminal event (SYM-386). claude still streams via `runTurn`.
        const outcome: TurnOutcome =
          resolved.engine === "pi"
            ? await runPushTurn(this.env, step, instanceId, {
                scope: resolved.scope,
                issueId: issueIdentifier,
                runId: sessionId,
                repoUrl: resolved.repoUrl,
                prompt: captured,
                engine: resolved.engine,
                model: resolved.model,
                thinkingLevel: resolved.thinkingLevel,
                githubToken,
                credentials: linearMcpCredentials,
                branch: deriveBranchFromIssueIdentifier(issueIdentifier),
                allowedTools: resolved.allowedTools,
                disallowedTools: resolved.disallowedTools,
                permissionMode: resolved.permissionMode,
                turn,
              })
            : await step.do(
                turnLabel,
                {
                  // Retry on eviction: `runTurn` re-attaches to the
                  // still-running engine process from a cursor instead
                  // of re-dispatching. Constant 2s so a ~5-min eviction
                  // re-attaches promptly; 20 attempts cover the 35-min
                  // dispatcher cap. 40-min timeout clears the
                  // dispatcher's MAX_TIMEOUT_MS plus SSE-close headroom.
                  retries: {
                    limit: 20,
                    delay: "2 seconds",
                    backoff: "constant",
                  },
                  timeout: "40 minutes",
                },
                async () =>
                  runTurn(this.env, sessionId, token, refreshLinearToken, {
                    scope: resolved.scope,
                    issueId: issueIdentifier,
                    repoUrl: resolved.repoUrl,
                    prompt: captured,
                    engine: resolved.engine,
                    model: resolved.model,
                    thinkingLevel: resolved.thinkingLevel,
                    githubToken,
                    credentials: linearMcpCredentials,
                    branch: deriveBranchFromIssueIdentifier(issueIdentifier),
                    allowedTools: resolved.allowedTools,
                    disallowedTools: resolved.disallowedTools,
                    permissionMode: resolved.permissionMode,
                    turn,
                  }),
              );

        if (outcome.kind === "dispatch_error") {
          batchTerminal = outcome;
          break;
        }
        if (outcome.lastAssistant) lastAssistant = outcome.lastAssistant;

        if (outcome.kind === "done") {
          batchTerminal = outcome;
          break;
        }

        // needs_continuation
        if (turn >= maxTurns) {
          // Treat hitting max_turns as done (engine ran out of budget;
          // surface the last assistant message as the response).
          batchTerminal = {
            kind: "done",
            result: outcome.result,
            lastAssistant: outcome.lastAssistant,
            inbandError: "max_turns_reached",
          };
          break;
        }

        // Build the next-turn prompt. Symphony's
        // `comment_watch.ex#continuation_section/1` is the reference;
        // for pi we only have the previous assistant message to weave
        // in (no Linear comment ingestion yet — that's item 7).
        prompt = buildContinuationPrompt(resolved.prompt, outcome.lastAssistant);
      }
      if (!batchTerminal) {
        // Unreachable in practice — the for-loop above always sets
        // `batchTerminal` on completion or break. Defensive default
        // for the type checker / paranoid eviction paths.
        batchTerminal = {
          kind: "dispatch_error",
          message: "unreachable_no_terminal_outcome",
        };
      }
      return batchTerminal;
    };

    // Everything from the first turn dispatch through the follow-up
    // wait loop is wrapped so that any Workflows-internal failure
    // (most commonly `WorkflowInternalError` from a long-running turn
    // step) still leaves us with a well-formed `terminal` and lets
    // the post-terminal-activity / record-session-end steps below run.
    // Without this, a thrown step would propagate up past the cleanup
    // and leave the agent_sessions row stuck in `running` and the
    // Linear session timeline with no terminal activity.
    try {
      terminal = await runTurnBatch(1);

      // Bounded wait for a follow-up `prompted` webhook between turn
      // batches. Linear marks sessions stale after ~30 minutes so we
      // wait just under that. If the user sends a new message in this
      // window we re-run the turn loop with the new prompt; otherwise
      // the wait rejects and we fall through to post-terminal-activity
      // exactly as before. We only re-enter while:
      //   - the previous batch ended cleanly (`done`, not dispatch_error)
      //   - we still have budget on the global `maxTurns` cap
      //
      // `turnsRun` is NOT reset across the wait — total turns include
      // follow-ups so a runaway conversation can't bypass the cap.
      while (
        terminal.kind === "done" &&
        !terminal.inbandError &&
        turnsRun < maxTurns
      ) {
        let followup: AgentSessionEventWebhook | null = null;
        try {
          const event = await step.waitForEvent<AgentSessionEventWebhook>(
            `wait-for-prompted-${turnsRun}`,
            // Dot-free type — Workflows rejects `.`. Must match the
            // `sendEvent` type in webhook.ts.
            { type: "linear-prompted", timeout: "25 minutes" },
          );
          followup = event.payload as AgentSessionEventWebhook;
        } catch {
          // Timeout (or any other step.waitForEvent rejection) → fall
          // through to post-terminal-activity. We deliberately do NOT
          // log here at error level; a 25-minute idle is the common
          // case for a one-shot session.
          break;
        }

        // Re-derive the prompt from the follow-up payload. If the
        // follow-up carries no prompt (rare — Linear should always
        // include one) we fall back to the previous prompt so the
        // engine at least has something to work with.
        const followupPrompt = resolvePrompt(followup) ?? resolved.prompt;
        // Re-apply the Linear GraphQL skill marker on the new prompt
        // so follow-ups stay wired to the Linear skill. Idempotent.
        prompt = withLinearGraphqlReference(followupPrompt, {
          issueId: webhookEvent.agentSession.issue?.id ?? null,
          issueIdentifier:
            webhookEvent.agentSession.issue?.identifier ?? null,
          teamId:
            webhookEvent.agentSession.issue?.teamId ??
            webhookEvent.agentSession.issue?.team?.id ??
            null,
        });

        terminal = await runTurnBatch(turnsRun + 1);
      }
    } catch (e) {
      const message =
        e instanceof Error
          ? `workflow_internal_error: ${e.message}`
          : "workflow_internal_error: unknown";
      terminal = { kind: "dispatch_error", message };
      console.error(
        "agent_session_aborted",
        JSON.stringify({
          session_id: sessionId,
          turns_run: turnsRun,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }

    await step.do("post-terminal-activity", async () => {
      const linear = buildActivityClient(token, refreshLinearToken);
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

    // Plan update is intentionally a separate step from the terminal
    // activity so a Linear API hiccup on one doesn't block the other.
    // Same `created`-only guard as `start-session-side-effects`: we
    // only own the plan on the first dispatch — prompted follow-ups
    // shouldn't rewrite it.
    if (webhookEvent.action === "created") {
      await step.do("update-final-plan", async () => {
        try {
          const succeeded =
            terminal.kind === "done" &&
            terminal.result.exit_code === 0 &&
            !terminal.inbandError;
          await updateAgentSession(token, {
            agentSessionId: sessionId,
            plan: [
              { content: "Preparing sandbox", status: "completed" },
              {
                content: "Running agent",
                status: succeeded ? "completed" : "canceled",
              },
            ],
          }, refreshLinearToken);
        } catch (e) {
          console.error(
            "agent_session_plan_final_failed",
            e instanceof Error ? e.message : String(e),
          );
        }
      });
    }

    await step.do("record-session-end", async () => {
      try {
        const finalStatus =
          terminal.kind === "dispatch_error"
            ? "error"
            : terminal.kind === "done" && terminal.result.exit_code === 0
              ? "completed"
              : "error";
        const errorMsg =
          terminal.kind === "dispatch_error"
            ? terminal.message
            : terminal.kind === "done" && terminal.inbandError
              ? terminal.inbandError
              : null;
        // `messages` is no longer written here — the streaming turn
        // persists each event to `agent_session_events` as it arrives,
        // so the dashboard reads from there now. Leaving the column
        // untouched preserves any historical JSON for sessions that
        // pre-date the table.
        await new AgentSessionStore(this.env.DB).update(sessionId, {
          status: finalStatus,
          completedAt: Math.floor(Date.now() / 1000),
          error: errorMsg,
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
    instanceId: string,
  ): Promise<{
    status: string;
    exit_code?: number | null;
    turns?: number;
    pr_url?: null;
  }> {
    try {
      return await this.runTriggerModeInner(params, step, instanceId);
    } finally {
      // Sandbox is keyed by the run id (= session id), not the issue.
      await this.stopSandboxQuiet(step, params.sessionId);
    }
  }

  private async runTriggerModeInner(
    params: Extract<SessionRunnerParams, { mode: "trigger" }>,
    step: WorkflowStep,
    instanceId: string,
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
      thinkingLevel,
      maxTurns,
      scope,
      issueIdentifier,
    } = params;
    const engine = normalizeEngineName(params.engine);
    // Only Linear subjects get the Linear skill reference. Generic API
    // invocations must run headlessly with no Linear API side effects.
    const prompt =
      params.event.subject?.kind === "linear_issue"
        ? withLinearGraphqlReference(params.prompt, { issueIdentifier })
        : params.prompt;

    const dispatchBranch = dispatchBranchForSubject(
      params.event.subject,
      issueIdentifier,
    );

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
    let terminal: TurnOutcome = {
      kind: "dispatch_error",
      message: "workflow_aborted_before_terminal_state",
    };
    let turnsRun = 0;

    // Same wrap as runAgentSessionMode: any throw from a turn step
    // (most commonly WorkflowInternalError after ~5 min of SSE
    // streaming) is converted into a clean error terminal so
    // trigger-record-session-end below still runs.
    try {
      for (let turn = 1; turn <= maxTurns; turn++) {
        turnsRun = turn;
        const captured = currentPrompt;

        // pi: engine-push (see runAgentSessionMode). claude: SSE turn.
        const outcome: TurnOutcome =
          engine === "pi"
            ? await runPushTurn(this.env, step, instanceId, {
                scope,
                issueId: issueIdentifier,
                runId: sessionId,
                repoUrl,
                prompt: captured,
                engine,
                model,
                thinkingLevel,
                githubToken,
                credentials: null,
                branch: dispatchBranch,
                allowedTools: params.workflow.allowed_tools ?? null,
                disallowedTools: params.workflow.disallowed_tools ?? null,
                permissionMode: params.workflow.permission_mode ?? null,
                turn,
              })
            : await step.do(
                `trigger-turn-${turn}`,
                {
                  retries: {
                    limit: 20,
                    delay: "2 seconds",
                    backoff: "constant",
                  },
                  timeout: "40 minutes",
                },
                async () =>
                  runTurnHeadless(this.env, sessionId, {
                    scope,
                    issueId: issueIdentifier,
                    repoUrl,
                    prompt: captured,
                    engine,
                    model,
                    thinkingLevel,
                    githubToken,
                    credentials: null,
                    branch: dispatchBranch,
                    allowedTools: params.workflow.allowed_tools ?? null,
                    disallowedTools: params.workflow.disallowed_tools ?? null,
                    permissionMode: params.workflow.permission_mode ?? null,
                    turn,
                  }),
              );

        if (outcome.kind === "dispatch_error") {
          terminal = outcome;
          break;
        }
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
          };
          break;
        }

        currentPrompt = buildContinuationPrompt(prompt, outcome.lastAssistant);
      }
    } catch (e) {
      const message =
        e instanceof Error
          ? `workflow_internal_error: ${e.message}`
          : "workflow_internal_error: unknown";
      terminal = { kind: "dispatch_error", message };
      console.error(
        "trigger_session_aborted",
        JSON.stringify({
          session_id: sessionId,
          turns_run: turnsRun,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }

    await step.do("trigger-record-session-end", async () => {
      try {
        const finalStatus =
          terminal.kind === "dispatch_error"
            ? "error"
            : terminal.kind === "done" && terminal.result.exit_code === 0
              ? "completed"
              : "error";
        const errorMsg =
          terminal.kind === "dispatch_error"
            ? terminal.message
            : terminal.kind === "done" && terminal.inbandError
              ? terminal.inbandError
              : null;
        // See runAgentSessionMode — events are persisted live to
        // `agent_session_events` so we don't write `messages` here.
        await new AgentSessionStore(this.env.DB).update(sessionId, {
          status: finalStatus,
          completedAt: Math.floor(Date.now() / 1000),
          error: errorMsg,
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

function normalizeEngineName(engine: string): string {
  return engine === "claude-code" ? "claude" : engine;
}

/**
 * Run one pi turn via the engine-push path (SYM-386). Unlike `runTurn`
 * (SSE), this holds nothing open: `start-run-N` fires the dispatcher's
 * `/run/start` and returns, then `run-terminal-N` parks on the
 * `run.terminal` workflow event the ingest endpoint sends when the run
 * finishes. Workflow eviction during the wait is free — on resume the
 * step journal replays `start-run-N` and re-enters the wait, so there
 * is no SSE re-attach.
 *
 * pi runs its whole agentic loop in one invocation, so this always
 * resolves to `done` or `dispatch_error` — never `needs_continuation`.
 * Events + live Linear activities are handled by the ingest endpoint,
 * not here.
 */
async function runPushTurn(
  env: Env,
  step: WorkflowStep,
  instanceId: string,
  args: {
    scope: string;
    issueId: string;
    runId: string;
    repoUrl: string;
    prompt: string;
    engine: string;
    model: string | null;
    thinkingLevel: string | null;
    githubToken: string | null;
    credentials: RunCredentials | null;
    branch: string | null;
    allowedTools: string[] | null;
    disallowedTools: string[] | null;
    permissionMode: string | null;
    turn: number;
  },
): Promise<TurnOutcome> {
  const dispatcher = new DispatcherClient(
    env.DISPATCHER_URL,
    env.DISPATCH_HMAC_SECRET,
  );

  const startOutcome = await step.do(
    `start-run-${args.turn}`,
    { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
    async (): Promise<{ ok: true } | { ok: false; message: string }> => {
      try {
        await dispatcher.start({
          scope: args.scope,
          issueId: args.issueId,
          runId: args.runId,
          instanceId,
          // The dispatcher builds the forwarder's ingest URL from this
          // worker's own public origin.
          ingestUrl: env.URL,
          repoUrl: args.repoUrl,
          prompt: args.prompt,
          engine: args.engine,
          model: args.model,
          thinkingLevel: args.thinkingLevel,
          githubToken: args.githubToken,
          credentials: args.credentials,
          branch: args.branch,
          allowedTools: args.allowedTools,
          disallowedTools: args.disallowedTools,
          permissionMode: args.permissionMode,
          turn: args.turn,
        });
        return { ok: true };
      } catch (e) {
        // A 4xx is a permanent contract/config failure (bad request,
        // missing baseline) — surface it instead of burning retries.
        // 5xx / network errors throw on through so step.do retries.
        if (
          e instanceof DispatcherError &&
          e.status >= 400 &&
          e.status < 500
        ) {
          return {
            ok: false,
            message: `dispatch_error (${e.status}): ${
              typeof e.body === "string" ? e.body : e.body.error
            }`,
          };
        }
        throw e;
      }
    },
  );

  if (!startOutcome.ok) {
    return { kind: "dispatch_error", message: startOutcome.message };
  }

  let payload: RunTerminalPayload;
  try {
    const ev = await step.waitForEvent<RunTerminalPayload>(
      `run-terminal-${args.turn}`,
      { type: RUN_TERMINAL_EVENT, timeout: "40 minutes" },
    );
    payload = ev.payload;
  } catch {
    // waitForEvent rejects on timeout — the forwarder never reported a
    // terminal batch (engine hung, sandbox died, or forwarder crashed
    // before it could POST). Surface it as a clean dispatch error.
    return { kind: "dispatch_error", message: "run_terminal_timeout" };
  }

  return {
    kind: "done",
    result: {
      exit_code: payload.exit_code,
      duration_ms: 0,
      branch: null,
      pr_url: null,
    },
    lastAssistant: payload.last_assistant,
    inbandError:
      payload.exit_code === 0 ? null : payload.error ?? "engine_failed",
  };
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
  refreshLinearToken: LinearTokenRefresher,
  args: {
    scope: string;
    issueId: string;
    repoUrl: string;
    prompt: string;
    engine: string;
    model: string | null;
    thinkingLevel: string | null;
    githubToken: string | null;
    credentials: RunCredentials | null;
    branch: string | null;
    allowedTools: string[] | null;
    disallowedTools: string[] | null;
    permissionMode: string | null;
    turn: number;
  },
): Promise<TurnOutcome> {
  const linear = buildActivityClient(token, refreshLinearToken);
  const dispatcher = new DispatcherClient(
    env.DISPATCHER_URL,
    env.DISPATCH_HMAC_SECRET,
  );
  const eventStore = new AgentSessionEventStore(env.DB);

  let result: TurnResult | null = null;
  let inbandError: string | null = null;
  let lastAssistant: string | null = null;
  let turnEndReason: "completed" | "needs_continuation" | "error" | null = null;

  // Re-attach cursor: how many events this turn already persisted on a
  // prior (evicted) attempt. cursor === 0 → fresh dispatch; cursor > 0
  // → resume the still-running engine process after those events so a
  // retried step never re-dispatches or double-posts.
  const cursor = await eventStore.countByTurn(sessionId, args.turn);
  const stream =
    cursor > 0
      ? dispatcher.attachStream({
          issueId: args.issueId,
          runId: sessionId,
          turn: args.turn,
          cursor,
          engine: args.engine,
        })
      : dispatcher.runStream({
          scope: args.scope,
          issueId: args.issueId,
          runId: sessionId,
          repoUrl: args.repoUrl,
          prompt: args.prompt,
          engine: args.engine,
          model: args.model,
          thinkingLevel: args.thinkingLevel,
          githubToken: args.githubToken,
          credentials: args.credentials,
          branch: args.branch,
          allowedTools: args.allowedTools,
          disallowedTools: args.disallowedTools,
          permissionMode: args.permissionMode,
          turn: args.turn,
        });

  try {
    for await (const ev of stream) {
      // Persist every event to D1 as it arrives. Wrapped in `safe`
      // because a transient D1 hiccup must not abort the turn — the
      // engine keeps streaming regardless, and a missing timeline row
      // is strictly less bad than killing the whole run.
      await safe(() => persistEvent(eventStore, sessionId, args.turn, ev));

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
      if (ev.type === "assistant_msg" && ev.text.length > 0) {
        lastAssistant = ev.text;
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
    // The SSE closed without a terminal frame — almost always the
    // dispatcher Worker was evicted mid-stream. Throw so the Workflow
    // step retries and re-attaches from the cursor rather than ending
    // the turn as a hard failure.
    throw new Error("stream_closed_without_result_frame");
  }

  if (turnEndReason === "needs_continuation" && result.exit_code === 0) {
    return { kind: "needs_continuation", result, lastAssistant };
  }
  return { kind: "done", result, lastAssistant, inbandError };
}

/**
 * Headless turn — drives the dispatcher SSE stream like `runTurn` but
 * never posts back into Linear. Used by trigger-initiated sessions
 * which have no Linear AgentSession id to attach activities to. Still
 * persists each event to `agent_session_events` so the dashboard can
 * surface the timeline for headless runs.
 */
async function runTurnHeadless(
  env: Env,
  sessionId: string,
  args: {
    scope: string;
    issueId: string;
    repoUrl: string;
    prompt: string;
    engine: string;
    model: string | null;
    thinkingLevel: string | null;
    githubToken: string | null;
    credentials: RunCredentials | null;
    branch: string | null;
    allowedTools: string[] | null;
    disallowedTools: string[] | null;
    permissionMode: string | null;
    turn: number;
  },
): Promise<TurnOutcome> {
  const dispatcher = new DispatcherClient(
    env.DISPATCHER_URL,
    env.DISPATCH_HMAC_SECRET,
  );
  const eventStore = new AgentSessionEventStore(env.DB);

  let result: TurnResult | null = null;
  let inbandError: string | null = null;
  let lastAssistant: string | null = null;
  let turnEndReason: "completed" | "needs_continuation" | "error" | null = null;

  // Re-attach cursor — see runTurn for the rationale.
  const cursor = await eventStore.countByTurn(sessionId, args.turn);
  const stream =
    cursor > 0
      ? dispatcher.attachStream({
          issueId: args.issueId,
          runId: sessionId,
          turn: args.turn,
          cursor,
          engine: args.engine,
        })
      : dispatcher.runStream({
          scope: args.scope,
          issueId: args.issueId,
          runId: sessionId,
          repoUrl: args.repoUrl,
          prompt: args.prompt,
          engine: args.engine,
          model: args.model,
          thinkingLevel: args.thinkingLevel,
          githubToken: args.githubToken,
          credentials: args.credentials,
          branch: args.branch,
          allowedTools: args.allowedTools,
          disallowedTools: args.disallowedTools,
          permissionMode: args.permissionMode,
          turn: args.turn,
        });

  try {
    for await (const ev of stream) {
      await safe(() => persistEvent(eventStore, sessionId, args.turn, ev));

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
      if (ev.type === "assistant_msg" && ev.text.length > 0) {
        lastAssistant = ev.text;
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
    // The SSE closed without a terminal frame — almost always the
    // dispatcher Worker was evicted mid-stream. Throw so the Workflow
    // step retries and re-attaches from the cursor rather than ending
    // the turn as a hard failure.
    throw new Error("stream_closed_without_result_frame");
  }

  if (turnEndReason === "needs_continuation" && result.exit_code === 0) {
    return { kind: "needs_continuation", result, lastAssistant };
  }
  return { kind: "done", result, lastAssistant, inbandError };
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

// Build the truncated `body` column for one normalized event. Mirrors
// the per-type formatting that used to live in `summarizeEvents` but
// runs once per event instead of over an accumulated array. Returns
// null when the event has no useful body (e.g. `turn_end`) — the row
// is still inserted so consumers can see the boundary, just with a
// NULL body.
function summarizeOne(ev: NormalizedEvent): string | null {
  if (ev.type === "thought" || ev.type === "assistant_msg") {
    return truncate(ev.text, 500);
  }
  if (ev.type === "tool_call") {
    const argStr =
      typeof ev.args === "string" ? ev.args : JSON.stringify(ev.args ?? "");
    return `${ev.tool}(${truncate(argStr, 200)})`;
  }
  if (ev.type === "tool_result") {
    return truncate(ev.result ?? (ev.ok ? "ok" : "error"), 200);
  }
  if (ev.type === "error") {
    return ev.message;
  }
  if (ev.type === "result") {
    return `exit_code=${ev.exit_code}`;
  }
  return null;
}

async function persistEvent(
  store: AgentSessionEventStore,
  sessionId: string,
  turn: number,
  ev: NormalizedEvent,
): Promise<void> {
  await store.append(sessionId, {
    turn,
    ts: Date.now(),
    type: ev.type,
    body: summarizeOne(ev),
  });
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error("activity_post_failed", e instanceof Error ? e.message : e);
  }
}
