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
  createAttachment,
  postError,
  postResponse,
  postThought,
} from "../lib/activities";
import { GitHubError, addLabels, createPr } from "../lib/github";
import { mintInstallationToken } from "../lib/github-app";
import { transitionIssue } from "../lib/issues";
import {
  DispatcherClient,
  DispatcherError,
  type NormalizedEvent,
  type RunCredentials,
} from "../lib/dispatcher";
import { lastAssistantText, mapToActivity } from "../lib/event-mapper";
import { resolveLinearMcpToken } from "../lib/linear-token";
import { resolvePrompt, truncate } from "../lib/session-helpers";
import {
  AgentSessionStore,
  GitHubInstallStore,
  LinearAgentInstallStore,
  ProjectStore,
} from "../lib/store";
import type { AgentSessionEventWebhook } from "../types/agent-session";

export interface SessionRunnerParams {
  event: AgentSessionEventWebhook;
}

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
    const webhookEvent = event.payload.event;
    const sessionId = webhookEvent.agentSession.id;

    const installInfo = await step.do("load-token", async () => {
      const linearOrgId = webhookEvent.organizationId;
      if (!linearOrgId) return null;

      const installs = new LinearAgentInstallStore(this.env.DB);
      const install = await installs.getByLinearOrgId(linearOrgId);
      if (!install) return null;

      const github = await new GitHubInstallStore(this.env.DB).getByOrgId(
        install.organization_id,
      );
      return {
        token: install.access_token,
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

        const repoUrl = projectRow?.repo_url ?? null;
        if (!repoUrl) return { kind: "no_repo" } as const;

        const prompt = resolvePrompt(webhookEvent);
        if (!prompt) return { kind: "no_prompt" } as const;

        const engine = (projectRow?.engine ?? this.env.DEFAULT_ENGINE ?? "pi") as
          | "pi"
          | string;
        const model =
          projectRow?.model ?? (this.env.DEFAULT_MODEL || null);
        const maxTurns =
          projectRow?.max_turns ?? parseMaxTurns(this.env.DEFAULT_MAX_TURNS);
        const scope =
          projectRow?.scope ?? this.env.DEFAULT_SCOPE ?? "default";

        return {
          kind: "ok",
          repoUrl,
          prompt,
          engine: engine === "pi" ? "pi" : "pi",
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

    // Item 5: move the issue to "In Progress" on `created` deliveries
    // when it's currently in "Todo". No-op on `prompted` events
    // (already in flight) and on issues that aren't in Todo (Rework,
    // In Progress, Human Review, etc. all stay where they are).
    if (
      webhookEvent.action === "created" &&
      issueGraphqlId
    ) {
      await step.do("transition-to-in-progress", async () => {
        try {
          await transitionIssue(token, issueGraphqlId, "In Progress");
        } catch (e) {
          console.error(
            "transition_in_progress_failed",
            e instanceof Error ? e.message : String(e),
          );
        }
      });
    }

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
          if (!result) return null;
          return {
            mcp_servers: [
              {
                name: "linear",
                url: "https://mcp.linear.app/sse",
                token: result.accessToken,
              },
            ],
          } as RunCredentials;
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

    // Item 4: if the dispatch produced a branch AND the engine exited
    // cleanly, create the GitHub PR and attach it to the Linear issue.
    // Wrapped in its own step so the PR creation is checkpointed
    // independently from the terminal activity post — a workflow
    // restart after PR creation but before the Linear post won't make
    // a duplicate PR (GitHub's 422 fallback uses the existing one),
    // and a restart between the two ensures the attachment still
    // lands.
    let prUrl: string | null = null;
    if (
      terminal.kind === "done" &&
      terminal.result.exit_code === 0 &&
      terminal.result.branch &&
      githubToken
    ) {
      const branch = terminal.result.branch;
      const prGithubToken = githubToken;
      const issueIdent = issueIdentifier;
      const responseBody = lastAssistant ?? `Symphony agent run for ${issueIdent}`;

      prUrl = (await step.do(
        "create-pr-and-attach",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
        async () => {
          try {
            const pr = await createPr({
              repoUrl: resolved.repoUrl,
              branch,
              baseBranch: "main",
              title: `Symphony: ${issueIdent}`,
              body:
                responseBody.slice(0, 4000) +
                (issueGraphqlId ? `\n\n_Linear: \`${issueIdent}\`_` : ""),
              token: prGithubToken,
            });
            try {
              await addLabels({
                repoUrl: resolved.repoUrl,
                prNumber: pr.number,
                labels: ["symphony"],
                token: prGithubToken,
              });
            } catch (e) {
              // Label failure is non-fatal — the PR still exists.
              console.error(
                "label_add_failed",
                e instanceof Error ? e.message : String(e),
              );
            }
            if (issueGraphqlId) {
              try {
                await createAttachment(token, {
                  issueId: issueGraphqlId,
                  url: pr.url,
                  title: `PR: ${issueIdent}`,
                  subtitle: "Created by Symphony Agent",
                });
              } catch (e) {
                console.error(
                  "attachment_create_failed",
                  e instanceof Error ? e.message : String(e),
                );
              }
            }
            return pr.url;
          } catch (e) {
            const msg =
              e instanceof GitHubError
                ? `github_${e.status}`
                : e instanceof Error
                  ? e.message
                  : "unknown_github_error";
            console.error("create_pr_failed", msg);
            return null;
          }
        },
      )) as string | null;
    }

    // Item 5: once the PR is up and Linear's attachment is in place,
    // advance the issue to "Human Review" so a human takes the
    // approve/reject branch. We skip when there's no PR (no changes
    // to review) or when issueGraphqlId is missing (can't address the
    // issue). Errors don't fail the run — the human can move it
    // manually if Linear API hiccups.
    if (
      terminal.kind === "done" &&
      terminal.result.exit_code === 0 &&
      prUrl &&
      issueGraphqlId
    ) {
      await step.do("transition-to-human-review", async () => {
        try {
          await transitionIssue(token, issueGraphqlId, "Human Review");
        } catch (e) {
          console.error(
            "transition_human_review_failed",
            e instanceof Error ? e.message : String(e),
          );
        }
      });
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
        const withPr = prUrl ? `${summary}\n\nPR: ${prUrl}` : summary;
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
      pr_url: prUrl,
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
