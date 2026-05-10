import { describe, expect, it, vi } from "vitest";

// Mock the package so its `@cloudflare/containers` transitive dep
// doesn't fail to resolve under vitest's node env. We only need a
// stand-in for the types this test exercises; the real implementation
// only runs inside the Workers runtime.
vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(),
  parseSSEStream: vi.fn(),
  proxyToSandbox: vi.fn(async () => null),
}));

import { commitAndPush } from "../src/git";

interface FakeExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * FakeSandbox for git.ts unit tests. `execScript` is the queue of
 * canned exec results — one per `sandbox.exec` call. `execCalls`
 * records the commands so tests can assert on order + content.
 *
 * Mirrors the relevant slice of @cloudflare/sandbox's `Sandbox` shape
 * (just `exec`), not the full interface.
 */
class FakeSandbox {
  execCalls: string[] = [];
  execScript: FakeExecResult[] = [];

  async exec(cmd: string): Promise<FakeExecResult> {
    this.execCalls.push(cmd);
    const next = this.execScript.shift();
    if (!next) {
      throw new Error(
        `FakeSandbox.exec: ran out of canned results at call #${this.execCalls.length}: ${cmd.slice(0, 80)}`,
      );
    }
    return next;
  }
}

const baseArgs = {
  issueIdentifier: "SYM-271",
  githubToken: "ghp_test",
  defaultBranch: "main",
};

describe("commitAndPush — pi already committed (HEAD ahead of upstream)", () => {
  it("skips the staged-commit step, amends author, pushes HEAD", async () => {
    const sandbox = new FakeSandbox();
    sandbox.execScript = [
      // 1. git rev-list --count origin/main..HEAD
      { exitCode: 0, stdout: "1\n", stderr: "" },
      // 2. git status --porcelain (empty — pi already committed)
      { exitCode: 0, stdout: "", stderr: "" },
      // 3. git checkout -B linear/sym-271
      { exitCode: 0, stdout: "", stderr: "" },
      // 4. (skipped — no uncommitted changes)
      // 5. git commit --amend --reset-author --no-edit
      { exitCode: 0, stdout: "", stderr: "" },
      // 6. git rev-parse HEAD
      { exitCode: 0, stdout: "5d9db36abcdef\n", stderr: "" },
      // 7. git push (auth url + redirect)
      { exitCode: 0, stdout: "", stderr: "" },
    ];

    const result = await commitAndPush(
      sandbox as never,
      "/workspace/SYM-271",
      baseArgs,
    );

    expect(result).toEqual({
      branch: "linear/sym-271",
      commit_sha: "5d9db36abcdef",
    });
    expect(sandbox.execCalls).toHaveLength(6);
    // The skipped "git add + commit" branch is the bug from SYM-267 item 4 —
    // pin the order to catch a regression.
    expect(sandbox.execCalls[0]).toContain("git rev-list --count");
    expect(sandbox.execCalls[1]).toContain("git status --porcelain");
    expect(sandbox.execCalls[2]).toContain("checkout -B 'linear/sym-271'");
    expect(sandbox.execCalls[3]).toContain("commit --amend --reset-author");
    expect(sandbox.execCalls[4]).toContain("git rev-parse HEAD");
    expect(sandbox.execCalls[5]).toContain("git push");
    // The push command must redirect stderr to /dev/null to keep the
    // PAT out of any captured stream.
    expect(sandbox.execCalls[5]).toContain(">/dev/null 2>&1");
  });

  it("uses the issue id in the branch name with lowercase", async () => {
    const sandbox = new FakeSandbox();
    sandbox.execScript = [
      { exitCode: 0, stdout: "1\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "sha\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    const result = await commitAndPush(sandbox as never, "/workspace/SYM-99", {
      ...baseArgs,
      issueIdentifier: "SYM-99",
    });
    expect(result?.branch).toBe("linear/sym-99");
  });
});

describe("commitAndPush — engine left uncommitted changes", () => {
  it("stages + commits + amends author + pushes", async () => {
    const sandbox = new FakeSandbox();
    sandbox.execScript = [
      // 1. git rev-list (0 commits ahead)
      { exitCode: 0, stdout: "0\n", stderr: "" },
      // 2. git status --porcelain (non-empty — pi only edited)
      { exitCode: 0, stdout: " M README.md\n", stderr: "" },
      // 3. checkout -B
      { exitCode: 0, stdout: "", stderr: "" },
      // 4. add + commit
      { exitCode: 0, stdout: "", stderr: "" },
      // 5. amend
      { exitCode: 0, stdout: "", stderr: "" },
      // 6. rev-parse
      { exitCode: 0, stdout: "deadbeef\n", stderr: "" },
      // 7. push
      { exitCode: 0, stdout: "", stderr: "" },
    ];

    const result = await commitAndPush(
      sandbox as never,
      "/workspace/SYM-1",
      baseArgs,
    );

    expect(result?.commit_sha).toBe("deadbeef");
    expect(sandbox.execCalls).toHaveLength(7);
    expect(sandbox.execCalls[3]).toContain("git add -A");
    expect(sandbox.execCalls[3]).toContain("git -c user.email=");
    expect(sandbox.execCalls[3]).toContain(
      "commit -m 'Symphony: SYM-271'",
    );
  });
});

describe("commitAndPush — nothing to do", () => {
  it("returns null when no commits ahead and no uncommitted changes", async () => {
    const sandbox = new FakeSandbox();
    sandbox.execScript = [
      { exitCode: 0, stdout: "0\n", stderr: "" }, // rev-list
      { exitCode: 0, stdout: "", stderr: "" }, // status
    ];

    const result = await commitAndPush(
      sandbox as never,
      "/workspace/SYM-X",
      baseArgs,
    );
    expect(result).toBeNull();
    // Just the two detection calls — no checkout, no commit, no push.
    expect(sandbox.execCalls).toHaveLength(2);
  });
});

describe("commitAndPush — amend failure is non-fatal", () => {
  it("continues to push even if --amend --reset-author returns non-zero", async () => {
    const sandbox = new FakeSandbox();
    sandbox.execScript = [
      { exitCode: 0, stdout: "1\n", stderr: "" }, // rev-list
      { exitCode: 0, stdout: "", stderr: "" }, // status (empty, pi committed)
      { exitCode: 0, stdout: "", stderr: "" }, // checkout -B
      // Amend fails for some reason (e.g., empty commit message after reset)
      { exitCode: 1, stdout: "", stderr: "fatal: not a valid object name" },
      { exitCode: 0, stdout: "ce0ffee\n", stderr: "" }, // rev-parse
      { exitCode: 0, stdout: "", stderr: "" }, // push
    ];

    const result = await commitAndPush(
      sandbox as never,
      "/workspace/SYM-2",
      baseArgs,
    );
    expect(result?.commit_sha).toBe("ce0ffee");
  });
});

describe("commitAndPush — push security", () => {
  it("never echoes the GitHub PAT in any visible command output", async () => {
    const sandbox = new FakeSandbox();
    sandbox.execScript = [
      { exitCode: 0, stdout: "1\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "sha\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];

    await commitAndPush(sandbox as never, "/workspace/SYM-3", {
      ...baseArgs,
      githubToken: "ghp_super_secret_pat",
    });

    const pushCmd = sandbox.execCalls[5]!;
    // The PAT must appear inside a sed replacement, but the command
    // must also redirect stderr — otherwise a git failure message
    // would leak the URL (with the PAT) into the dispatcher's stdout.
    expect(pushCmd).toContain("ghp_super_secret_pat");
    expect(pushCmd).toContain(">/dev/null 2>&1");
    // It should NOT use `git remote set-url` (would persist the PAT to
    // .git/config on disk).
    expect(pushCmd).not.toContain("remote set-url");
  });
});

describe("commitAndPush — error propagation", () => {
  it("throws when git rev-list fails", async () => {
    const sandbox = new FakeSandbox();
    sandbox.execScript = [
      { exitCode: 128, stdout: "", stderr: "fatal: unknown revision" },
    ];

    await expect(
      commitAndPush(sandbox as never, "/workspace/x", baseArgs),
    ).rejects.toThrow(/git_rev_list_failed/);
  });

  it("throws when git checkout fails", async () => {
    const sandbox = new FakeSandbox();
    sandbox.execScript = [
      { exitCode: 0, stdout: "1\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 128, stdout: "", stderr: "fatal: bad branch name" },
    ];

    await expect(
      commitAndPush(sandbox as never, "/workspace/x", baseArgs),
    ).rejects.toThrow(/git_checkout_failed/);
  });

  it("throws when git push fails", async () => {
    const sandbox = new FakeSandbox();
    sandbox.execScript = [
      { exitCode: 0, stdout: "1\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "sha\n", stderr: "" },
      { exitCode: 128, stdout: "", stderr: "" },
    ];

    await expect(
      commitAndPush(sandbox as never, "/workspace/x", baseArgs),
    ).rejects.toThrow(/git_push_failed/);
  });
});
