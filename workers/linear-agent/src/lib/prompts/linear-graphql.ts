/**
 * Linear skill pointer appended to every prompt sent to the engine.
 *
 * Pi (and any engine the dispatcher runs) ships with a `linear` skill
 * baked into the sandbox baseline that wraps Linear's GraphQL API. The
 * skill handles auth + the query/mutation surface; the engine only
 * needs to know it exists and which per-session UUIDs to pass to it.
 *
 * We previously inlined a full GraphQL cheatsheet (endpoint, auth
 * header, queries, mutations) into every prompt. That bloated prompt
 * tokens, drifted out of sync with Linear's schema, and pushed
 * domain-specific knowledge into the orchestrator. The skill owns all
 * of that now — this module just tells the engine to use it.
 *
 * The dispatcher still injects `LINEAR_API_TOKEN` into the sandbox env
 * (see `linear_token` in `workers/sandbox-dispatcher/src/run.ts`); the
 * skill reads it as its bearer.
 */

const LINEAR_SKILL_REFERENCE_HEADER = `

---

## Linear access

Use the \`linear\` skill for all Linear work — fetching issues, posting
or updating comments, transitioning state, attaching PRs, creating
follow-up issues, adding labels, etc. The skill handles authentication
and the GraphQL surface; do not call \`https://api.linear.app/graphql\`
directly.

The skill reads its bearer from \`LINEAR_API_TOKEN\` in the sandbox env.
Never echo, log, or commit that value.

All Linear ID parameters the skill takes are opaque UUIDs (not
human-readable identifiers like \`SYM-32\`). Use the UUIDs from the
"Issue context for Linear API" block below for any \`issueId\` /
\`teamId\` argument.`;

/**
 * Per-session identifiers Pi needs to pass to the `linear` skill. The
 * skill otherwise has no way to know the issue's UUID (which differs
 * from the human-readable `SYM-32`-style identifier).
 */
export interface LinearGraphqlContext {
  /** Issue UUID — the value passed as `issueId` to the skill. */
  issueId?: string | null;
  /** Human identifier (`SYM-32`) — useful for log/message strings. */
  issueIdentifier?: string | null;
  /** Team UUID, when known — needed for issue creation, label lookup. */
  teamId?: string | null;
}

/**
 * Append the Linear skill pointer to a prompt unless it's already
 * present (idempotent — safe to call from multiple call sites,
 * including continuation-prompt builders that embed the original
 * prompt). When `context` is provided, a small "Issue context for
 * Linear API" block is rendered after the pointer so Pi can drop the
 * UUID straight into skill arguments.
 */
export function withLinearGraphqlReference(
  prompt: string,
  context?: LinearGraphqlContext,
): string {
  if (prompt.includes("## Linear access")) {
    return prompt;
  }
  return prompt + LINEAR_SKILL_REFERENCE_HEADER + renderContextBlock(context);
}

export const LINEAR_GRAPHQL_REFERENCE =
  LINEAR_SKILL_REFERENCE_HEADER + renderContextBlock(undefined);

function renderContextBlock(context: LinearGraphqlContext | undefined): string {
  if (!context) return "\n";
  const lines: string[] = [];
  if (context.issueId) lines.push(`- Issue UUID: \`${context.issueId}\``);
  if (context.issueIdentifier)
    lines.push(`- Issue identifier: \`${context.issueIdentifier}\``);
  if (context.teamId) lines.push(`- Team UUID: \`${context.teamId}\``);
  if (lines.length === 0) return "\n";
  return (
    "\n\n### Issue context for Linear API\n\n" +
    "Use these literal values when calling the `linear` skill:\n\n" +
    lines.join("\n") +
    "\n"
  );
}
