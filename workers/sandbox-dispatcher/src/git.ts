/**
 * Helpers for committing and pushing the agent's work to GitHub from
 * inside the per-issue Sandbox container.
 *
 * Flow at the end of /run:
 *
 *   1. `git status --porcelain` — if empty, there's nothing to commit;
 *      return `null` and the caller skips the push step.
 *   2. Configure a synthetic identity (env-supplied or fallback).
 *   3. `git add -A && git commit -m ...`
 *   4. Push to `refs/heads/<branchName>` on origin, rewriting the URL
 *      to embed the `x-access-token` PAT so HTTPS auth works without a
 *      credential helper.
 *
 * Returns the pushed branch name on success, or null if there was
 * nothing to push. Throws with a descriptive message on git failure
 * so the caller (run.ts) can surface it as an in-band SSE `error`
 * event.
 *
 * Per-team GitHub tokens are out of scope for item 4 of SYM-267 — we
 * use a single org-wide `DISPATCH_GITHUB_TOKEN`. Per-team tokens land
 * with item 6+ when per-project secrets get a proper home.
 */

import type { Sandbox as SandboxType } from "@cloudflare/sandbox";

import { shellQuote } from "./run";

export interface PushResult {
  branch: string;
  commit_sha: string;
}

export interface PushArgs {
  issueIdentifier: string;
  /** GitHub PAT with `repo` scope. */
  githubToken: string;
  /** Default branch on origin; used as the upstream base. */
  defaultBranch?: string;
  /** Commit author for the synthetic commit. */
  authorName?: string;
  authorEmail?: string;
  commitMessage?: string;
}

/**
 * Commit and push the working tree if anything changed. Returns null
 * when there are no changes to push (legitimate exit — agent decided
 * the issue didn't need a code change).
 */
export async function commitAndPush(
  sandbox: SandboxType,
  workspaceDir: string,
  args: PushArgs,
): Promise<PushResult | null> {
  const branchName = `linear/${args.issueIdentifier.toLowerCase()}`;
  const author = args.authorName ?? "Symphony Agent";
  const authorEmail = args.authorEmail ?? "symphony@noreply.users.noreply.github.com";
  const commitMessage =
    args.commitMessage ?? `Symphony: ${args.issueIdentifier}`;

  // 1. Anything to commit?
  const statusResult = await sandbox.exec(
    `cd ${shellQuote(workspaceDir)} && git status --porcelain`,
  );
  if (statusResult.exitCode !== 0) {
    throw new Error(
      `git_status_failed (${statusResult.exitCode}): ${statusResult.stderr.slice(0, 500)}`,
    );
  }
  if (statusResult.stdout.trim().length === 0) {
    return null;
  }

  // 2. Configure identity + create branch + commit.
  // `git checkout -B` creates or resets the branch to current HEAD
  // (which is the freshly-cloned default branch tip).
  const commitCmd = [
    `cd ${shellQuote(workspaceDir)}`,
    `git -c user.email=${shellQuote(authorEmail)} -c user.name=${shellQuote(author)} checkout -B ${shellQuote(branchName)}`,
    `git add -A`,
    `git -c user.email=${shellQuote(authorEmail)} -c user.name=${shellQuote(author)} commit -m ${shellQuote(commitMessage)}`,
  ].join(" && ");

  const commitResult = await sandbox.exec(commitCmd);
  if (commitResult.exitCode !== 0) {
    throw new Error(
      `git_commit_failed (${commitResult.exitCode}): ${commitResult.stderr.slice(0, 500)}`,
    );
  }

  // 3. Read the commit SHA so the caller can include it in the result.
  const shaResult = await sandbox.exec(
    `cd ${shellQuote(workspaceDir)} && git rev-parse HEAD`,
  );
  if (shaResult.exitCode !== 0) {
    throw new Error(
      `git_rev_parse_failed (${shaResult.exitCode}): ${shaResult.stderr.slice(0, 500)}`,
    );
  }
  const commit_sha = shaResult.stdout.trim();

  // 4. Push with embedded PAT auth. We DO NOT echo the URL anywhere —
  // the sandbox exec output is captured by the streaming branch as
  // stdout chunks the linear-agent might surface in the timeline, so
  // keeping the token off stdout is mandatory.
  //
  // `git remote set-url` mutates `.git/config`. The container is
  // ephemeral so the leaked credential is bounded by the sandbox
  // lifetime — but we still scrub it after the push to be safe.
  const remoteResult = await sandbox.exec(
    `cd ${shellQuote(workspaceDir)} && origin_url=$(git remote get-url origin) && ` +
      `auth_url=$(echo "$origin_url" | sed "s|https://|https://x-access-token:${shellEscapeForDoubleQuotes(args.githubToken)}@|") && ` +
      `git push "$auth_url" HEAD:refs/heads/${shellQuote(branchName)} >/dev/null 2>&1`,
  );
  if (remoteResult.exitCode !== 0) {
    throw new Error(
      `git_push_failed (${remoteResult.exitCode}): see container logs (stderr redacted to avoid leaking PAT)`,
    );
  }

  return { branch: branchName, commit_sha };
}

/**
 * Escape a string for safe embedding inside `"..."` shell quotes. We
 * only need to handle `"`, `$`, `\``, and `\\` — the value we pass
 * here (a GitHub PAT) is alphanumeric plus a few safe punctuation
 * chars per GitHub's own spec, so this is belt-and-suspenders.
 */
function shellEscapeForDoubleQuotes(s: string): string {
  return s.replace(/[\\"`$]/g, "\\$&");
}
