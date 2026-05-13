/**
 * Helpers for committing and pushing the agent's work to GitHub from
 * inside the per-issue Sandbox container.
 *
 * The engine may either:
 *   (a) **Commit on its own** (pi does this — it runs `git commit` as
 *       part of its task). HEAD ends up ahead of `origin/<default>`.
 *   (b) **Leave changes uncommitted** in the working tree (hypothetical
 *       future engines). `git status --porcelain` is non-empty.
 *
 * `commitAndPush` handles both cases. Flow at the end of /run:
 *
 *   1. Count commits ahead of `origin/<default-branch>`.
 *   2. If 0 ahead AND no uncommitted changes → return null (legitimate
 *      "no code change" outcome — caller skips PR creation).
 *   3. `git checkout -B linear/<issue-id>` so the branch label points at
 *      the work-bearing HEAD (whether engine-committed or about to be).
 *   4. If there were uncommitted changes, stage + commit them now.
 *   5. Amend HEAD with the Symphony Agent author so the PR's committer
 *      attribution is consistent regardless of what pi configured. This
 *      only rewrites HEAD (single-commit case); multi-commit engine
 *      chains keep their earlier authorship — call out as a v2 polish.
 *   6. Push HEAD to `refs/heads/<branchName>` on origin, rewriting the
 *      URL in-shell to embed the `x-access-token` PAT for HTTPS auth.
 *      Stderr is redacted so the PAT can't leak into the dispatcher's
 *      SSE stream.
 *
 * Returns the pushed branch name + commit SHA on success, or null if
 * the agent decided this issue didn't need a code change. Throws with
 * a descriptive message on git failure so the caller (run.ts) can
 * surface it as an in-band SSE `error` event.
 *
 * Per-team GitHub tokens are out of scope for SYM-269 — we use the
 * org-wide `DISPATCH_GITHUB_TOKEN` for now. SYM-269 swaps this for
 * Symphony GitHub App installation tokens minted per `/run`.
 */

import type { Sandbox as SandboxType } from "@cloudflare/sandbox";

import { buildAuthenticatedCloneUrl, redactToken, shellQuote } from "./run";

export interface PushResult {
  branch: string;
  commit_sha: string;
}

export interface PushArgs {
  issueIdentifier: string;
  /** Canonical `https://github.com/owner/repo[.git]` URL — the same URL
   * the workspace was cloned from. We do NOT read this back from
   * `git remote get-url origin` because clone stored an authenticated
   * URL there, and prepending another `x-access-token:` userinfo on
   * top of it produces a malformed URL that curl rejects. */
  repoUrl: string;
  /** GitHub PAT with `repo` scope. */
  githubToken: string;
  /** Default branch on origin; used as the upstream base. */
  defaultBranch?: string;
  /** Commit author for the synthetic commit. */
  authorName?: string;
  authorEmail?: string;
  commitMessage?: string;
}

export async function commitAndPush(
  sandbox: SandboxType,
  workspaceDir: string,
  args: PushArgs,
): Promise<PushResult | null> {
  const branchName = `linear/${args.issueIdentifier.toLowerCase()}`;
  const author = args.authorName ?? "Symphony Agent";
  const authorEmail =
    args.authorEmail ?? "symphony@noreply.users.noreply.github.com";
  const commitMessage =
    args.commitMessage ?? `Symphony: ${args.issueIdentifier}`;
  const defaultBranch = args.defaultBranch ?? "main";
  const upstreamRef = `origin/${defaultBranch}`;

  // 1. How many commits is HEAD ahead of upstream? Pi may have already
  // committed; this is how we detect that case.
  const aheadResult = await sandbox.exec(
    `cd ${shellQuote(workspaceDir)} && git rev-list --count ${shellQuote(upstreamRef)}..HEAD`,
  );
  if (aheadResult.exitCode !== 0) {
    throw new Error(
      `git_rev_list_failed (${aheadResult.exitCode}): ${aheadResult.stderr.slice(0, 500)}`,
    );
  }
  const commitsAhead = parseInt(aheadResult.stdout.trim(), 10) || 0;

  // 2. Any uncommitted changes in the working tree?
  const statusResult = await sandbox.exec(
    `cd ${shellQuote(workspaceDir)} && git status --porcelain`,
  );
  if (statusResult.exitCode !== 0) {
    throw new Error(
      `git_status_failed (${statusResult.exitCode}): ${statusResult.stderr.slice(0, 500)}`,
    );
  }
  const hasUncommitted = statusResult.stdout.trim().length > 0;

  // 3. Nothing to do?
  if (commitsAhead === 0 && !hasUncommitted) {
    return null;
  }

  // 4. Move/create the branch label at HEAD. If pi committed, HEAD is
  // its commit and we branch from there. If pi only edited, HEAD is
  // the cloned tip and we branch + commit below.
  const checkoutResult = await sandbox.exec(
    `cd ${shellQuote(workspaceDir)} && ` +
      `git -c user.email=${shellQuote(authorEmail)} -c user.name=${shellQuote(author)} ` +
      `checkout -B ${shellQuote(branchName)}`,
  );
  if (checkoutResult.exitCode !== 0) {
    throw new Error(
      `git_checkout_failed (${checkoutResult.exitCode}): ${checkoutResult.stderr.slice(0, 500)}`,
    );
  }

  // 5. If pi only edited (no commit), stage + commit now with our
  // identity. If pi already committed, this block is skipped — its
  // commit is already on HEAD.
  if (hasUncommitted) {
    const commitResult = await sandbox.exec(
      [
        `cd ${shellQuote(workspaceDir)}`,
        `git add -A`,
        `git -c user.email=${shellQuote(authorEmail)} -c user.name=${shellQuote(author)} commit -m ${shellQuote(commitMessage)}`,
      ].join(" && "),
    );
    if (commitResult.exitCode !== 0) {
      throw new Error(
        `git_commit_failed (${commitResult.exitCode}): ${commitResult.stderr.slice(0, 500)}`,
      );
    }
  }

  // 6. Rewrite HEAD's author + committer to the Symphony Agent identity
  // so the PR shows consistent attribution regardless of how pi
  // configured git. `--reset-author` only affects HEAD; multi-commit
  // engine chains keep their earlier authorship. Non-fatal: a failure
  // here just means the original author shows on GitHub.
  const amendResult = await sandbox.exec(
    `cd ${shellQuote(workspaceDir)} && ` +
      `git -c user.email=${shellQuote(authorEmail)} -c user.name=${shellQuote(author)} ` +
      `commit --amend --reset-author --no-edit`,
  );
  if (amendResult.exitCode !== 0) {
    console.log(
      "git_amend_failed_nonfatal",
      JSON.stringify({
        exit_code: amendResult.exitCode,
        stderr: amendResult.stderr.slice(0, 200),
      }),
    );
  }

  // 7. Read the commit SHA after potential amend.
  const shaResult = await sandbox.exec(
    `cd ${shellQuote(workspaceDir)} && git rev-parse HEAD`,
  );
  if (shaResult.exitCode !== 0) {
    throw new Error(
      `git_rev_parse_failed (${shaResult.exitCode}): ${shaResult.stderr.slice(0, 500)}`,
    );
  }
  const commit_sha = shaResult.stdout.trim();

  // 8. Push with embedded PAT auth. The auth URL is built from
  // `args.repoUrl` (the canonical URL the workspace was cloned from),
  // NOT from `git remote get-url origin` — the remote already contains
  // a `x-access-token:<TOKEN>@` userinfo from clone, and stacking
  // another set of credentials on top yields a malformed URL that curl
  // rejects (CURLE_URL_MALFORMAT). Building from the canonical URL
  // produces exactly one userinfo block.
  //
  // We pass the URL as an argv argument (not a `$(…)` expansion in the
  // shell) so the token never touches stdout via command substitution.
  // Stdout is dropped because git can echo the URL on success ("To
  // https://x-access-token:…@github.com/…"). Stderr is captured and
  // run through `redactToken` so failure diagnostics surface without
  // the PAT.
  //
  // `git remote set-url` would persist the PAT in `.git/config`; we
  // avoid that by passing the URL inline (the container is ephemeral
  // but defense-in-depth).
  const authUrl = buildAuthenticatedCloneUrl(args.repoUrl, args.githubToken);
  const remoteResult = await sandbox.exec(
    `cd ${shellQuote(workspaceDir)} && ` +
      `git push ${shellQuote(authUrl)} HEAD:refs/heads/${shellQuote(branchName)} >/dev/null`,
  );
  if (remoteResult.exitCode !== 0) {
    const stderr = redactToken(remoteResult.stderr ?? "", args.githubToken)
      .trim()
      .slice(0, 500);
    throw new Error(
      `git_push_failed (${remoteResult.exitCode})${stderr ? `: ${stderr}` : ""}`,
    );
  }

  return { branch: branchName, commit_sha };
}
