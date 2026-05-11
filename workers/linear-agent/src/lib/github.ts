/**
 * Minimal GitHub REST API client for the linear-agent worker.
 *
 * Item 4 of SYM-267 introduces post-engine PR creation. The flow is:
 *
 *   1. Dispatcher pushes the agent's commits to `linear/<issue-id>`
 *      and reports the branch name in the SSE `result` event.
 *   2. This client creates a PR from that branch into the repo's
 *      default branch, applies the `symphony` label, and returns the
 *      PR URL. The SessionRunner then posts that URL to Linear via
 *      `attachmentCreate` (see lib/activities.ts).
 *
 * Auth: PAT bound as the `GITHUB_TOKEN` secret on the worker. We
 * don't reuse the dispatcher's secret — each worker keeps its own
 * threat model.
 */

const GITHUB_API = "https://api.github.com";

export interface CreatePrArgs {
  /** Repo URL like `https://github.com/owner/repo.git`. */
  repoUrl: string;
  /** Source branch (head). */
  branch: string;
  /** Target branch (base). Defaults to "main". */
  baseBranch?: string;
  title: string;
  body: string;
  token: string;
}

export interface CreatePrResult {
  url: string;
  number: number;
}

export class GitHubError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`github_error: ${status}`);
    this.name = "GitHubError";
  }
}

export async function createPr(args: CreatePrArgs): Promise<CreatePrResult> {
  const { owner, repo } = parseRepoUrl(args.repoUrl);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls`;

  const res = await fetch(url, {
    method: "POST",
    headers: ghHeaders(args.token),
    body: JSON.stringify({
      title: args.title,
      head: args.branch,
      base: args.baseBranch ?? "main",
      body: args.body,
      maintainer_can_modify: true,
    }),
  });

  if (!res.ok) {
    // If GitHub says "A pull request already exists" (422), fall back
    // to looking up the existing PR for this head branch. This makes
    // the post-PR step idempotent across Workflow retries.
    if (res.status === 422) {
      const existing = await findPrForBranch(
        owner,
        repo,
        args.branch,
        args.token,
      );
      if (existing) return existing;
    }
    throw new GitHubError(res.status, await res.json().catch(() => null));
  }
  const json = (await res.json()) as { html_url: string; number: number };
  return { url: json.html_url, number: json.number };
}

export async function addLabels(args: {
  repoUrl: string;
  prNumber: number;
  labels: string[];
  token: string;
}): Promise<void> {
  const { owner, repo } = parseRepoUrl(args.repoUrl);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${args.prNumber}/labels`;
  const res = await fetch(url, {
    method: "POST",
    headers: ghHeaders(args.token),
    body: JSON.stringify({ labels: args.labels }),
  });
  if (!res.ok) {
    throw new GitHubError(res.status, await res.json().catch(() => null));
  }
}

async function findPrForBranch(
  owner: string,
  repo: string,
  branch: string,
  token: string,
): Promise<CreatePrResult | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) return null;
  const arr = (await res.json()) as Array<{ html_url: string; number: number }>;
  const first = arr[0];
  if (!first) return null;
  return { url: first.html_url, number: first.number };
}

/**
 * Parse a GitHub repo URL into owner/repo. Supports
 * `https://github.com/owner/repo` and `.git`-suffixed variants.
 * Rejects anything else with a descriptive error so the workflow
 * doesn't post a confusing 404 to Linear.
 */
export function parseRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const m = repoUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m || !m[1] || !m[2]) {
    throw new Error(`invalid_github_repo_url: ${repoUrl}`);
  }
  return { owner: m[1], repo: m[2] };
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "symphony-linear-agent",
  };
}
