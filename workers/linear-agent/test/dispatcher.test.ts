import { describe, expect, it, vi } from "vitest";

import {
  DispatcherClient,
  DispatcherError,
  computeSignature,
  deriveBranchFromIssueIdentifier,
  dispatchBranchForSubject,
} from "../src/lib/dispatcher";
import {
  genericSubjectSchema,
  githubIssueSubjectSchema,
  githubPrSubjectSchema,
  linearIssueSubjectSchema,
} from "../src/schemas/event";

/**
 * The pinned vector below is the same one the Elixir client and the
 * dispatcher worker test against. If any of the three signers diverges,
 * one of the three test suites will fail loudly:
 *
 *   workers/sandbox-dispatcher/test/hmac.test.ts
 *   test/symphony_elixir/cloudflare/dispatcher_client_test.exs
 *   workers/linear-agent/test/dispatcher.test.ts (this file)
 *
 * Source of truth: docs/cloudflare_sandbox_integration.md ("HMAC signing
 * — exact contract").
 */
const PINNED_SECRET = "test-secret-do-not-use-in-prod";
const PINNED_BODY = '{"scope":"alice"}';
const PINNED_SIG = "1628b1de2425d3d72af853cd72a18a7cdadda178157642d42411d70760b15b46";

describe("deriveBranchFromIssueIdentifier", () => {
  it("lowercases Linear identifiers and prefixes with symphony/", () => {
    expect(deriveBranchFromIssueIdentifier("SYM-123")).toBe("symphony/sym-123");
    expect(deriveBranchFromIssueIdentifier("BACH-7")).toBe("symphony/bach-7");
  });

  it("accepts UUID-style session-id fallbacks", () => {
    expect(
      deriveBranchFromIssueIdentifier("e6ff2862-1971-4b10-88a8-4aa16137fff0"),
    ).toBe("symphony/e6ff2862-1971-4b10-88a8-4aa16137fff0");
  });

  it("sanitizes unsafe characters and trims edges", () => {
    expect(deriveBranchFromIssueIdentifier("SYM 162")).toBe("symphony/sym-162");
    expect(deriveBranchFromIssueIdentifier("--SYM-1--")).toBe("symphony/sym-1");
  });

  it("returns null when identifier produces nothing usable", () => {
    expect(deriveBranchFromIssueIdentifier("")).toBeNull();
    expect(deriveBranchFromIssueIdentifier("---")).toBeNull();
  });
});

describe("dispatchBranchForSubject", () => {
  it("checks out the PR head branch for github_pr subjects", () => {
    const subject = githubPrSubjectSchema.parse({
      kind: "github_pr",
      repo: "markoinla/symphony",
      number: 234,
      head: "test/linear-agent-workflow-pr",
      base: "main",
    });
    expect(dispatchBranchForSubject(subject, "markoinla/symphony#234")).toBe(
      "test/linear-agent-workflow-pr",
    );
  });

  it("derives a branch when a github_pr has no head ref", () => {
    const subject = githubPrSubjectSchema.parse({
      kind: "github_pr",
      repo: "markoinla/symphony",
      number: 234,
    });
    // head defaults to "" — fall back to the identifier-derived branch.
    expect(dispatchBranchForSubject(subject, "markoinla/symphony#234")).toBe(
      "symphony/markoinla-symphony-234",
    );
  });

  it("derives a per-issue branch for non-PR subjects", () => {
    const linear = linearIssueSubjectSchema.parse({
      kind: "linear_issue",
      id: "issue-uuid",
    });
    expect(dispatchBranchForSubject(linear, "SYM-162")).toBe("symphony/sym-162");

    const ghIssue = githubIssueSubjectSchema.parse({
      kind: "github_issue",
      repo: "markoinla/symphony",
      number: 9,
    });
    expect(dispatchBranchForSubject(ghIssue, "markoinla/symphony#9")).toBe(
      "symphony/markoinla-symphony-9",
    );

    const generic = genericSubjectSchema.parse({
      kind: "generic",
      external_id: "evt-1",
    });
    expect(dispatchBranchForSubject(generic, "evt-1")).toBe("symphony/evt-1");
  });

  it("derives from the identifier when there is no subject", () => {
    expect(dispatchBranchForSubject(undefined, "SYM-7")).toBe("symphony/sym-7");
  });
});

describe("computeSignature", () => {
  it("matches the cross-language pinned vector", async () => {
    expect(await computeSignature(PINNED_SECRET, PINNED_BODY)).toBe(PINNED_SIG);
  });

  it("emits lowercase hex", async () => {
    const sig = await computeSignature("k", "body");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("DispatcherClient.run", () => {
  it("POSTs /run with HMAC, JSON body, and returns parsed result", async () => {
    const fetchImpl = vi.fn(
      async (input: Request | string, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        expect(url).toBe("https://dispatcher.example/run");
        const body = init?.body as string;
        expect(JSON.parse(body)).toEqual({
          scope: "alice",
          issue_id: "SYM-1",
          repo_url: "https://github.com/x/y.git",
          prompt: "do a thing",
          engine: "pi",
          model: "anthropic/claude-sonnet-4-6",
          turn: 1,
        });

        const headers = new Headers(init?.headers);
        const expected = await computeSignature("hmac-secret", body);
        expect(headers.get("X-Symphony-Signature")).toBe(expected);
        expect(headers.get("Content-Type")).toBe("application/json");

        return new Response(
          JSON.stringify({
            engine: "pi",
            exit_code: 0,
            stdout: "hello",
            stderr: "",
            duration_ms: 1234,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );

    const client = new DispatcherClient(
      "https://dispatcher.example",
      "hmac-secret",
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.run({
      scope: "alice",
      issueId: "SYM-1",
      repoUrl: "https://github.com/x/y.git",
      prompt: "do a thing",
      engine: "pi",
      model: "anthropic/claude-sonnet-4-6",
    });

    expect(result).toEqual({
      engine: "pi",
      exit_code: 0,
      stdout: "hello",
      stderr: "",
      duration_ms: 1234,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("strips a trailing slash from the dispatcher URL", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = new DispatcherClient(
      "https://dispatcher.example/",
      "k",
      fetchImpl as unknown as typeof fetch,
    );
    await client.run({
      scope: "a",
      issueId: "i",
      repoUrl: "https://x.y/z.git",
      prompt: "p",
      engine: "pi",
    });
    const firstCall = fetchImpl.mock.calls[0] as unknown as [string, unknown] | undefined;
    expect(firstCall?.[0]).toBe("https://dispatcher.example/run");
  });

  it("throws DispatcherError on non-2xx with the parsed JSON body", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "missing_auth_backup", scope: "x" }), {
          status: 412,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = new DispatcherClient(
      "https://dispatcher.example",
      "k",
      fetchImpl as unknown as typeof fetch,
    );
    await expect(
      client.run({
        scope: "x",
        issueId: "i",
        repoUrl: "https://x.y/z.git",
        prompt: "p",
        engine: "pi",
      }),
    ).rejects.toMatchObject({
      name: "DispatcherError",
      status: 412,
      body: { error: "missing_auth_backup", scope: "x" },
    });
  });

  it("falls back to text body when error response isn't JSON", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("oops", { status: 500 }),
    );
    const client = new DispatcherClient(
      "https://dispatcher.example",
      "k",
      fetchImpl as unknown as typeof fetch,
    );
    await expect(
      client.run({
        scope: "x",
        issueId: "i",
        repoUrl: "https://x.y/z.git",
        prompt: "p",
        engine: "pi",
      }),
    ).rejects.toBeInstanceOf(DispatcherError);
  });

  it("omits model from the body when not provided", async () => {
    let capturedBody = "";
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response("{}", { status: 200 });
    });
    const client = new DispatcherClient(
      "https://dispatcher.example",
      "k",
      fetchImpl as unknown as typeof fetch,
    );
    await client.run({
      scope: "a",
      issueId: "i",
      repoUrl: "https://x.y/z.git",
      prompt: "p",
      engine: "pi",
    });
    expect(JSON.parse(capturedBody)).not.toHaveProperty("model");
  });

  it("includes branch in the body when provided", async () => {
    let capturedBody = "";
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response("{}", { status: 200 });
    });
    const client = new DispatcherClient(
      "https://dispatcher.example",
      "k",
      fetchImpl as unknown as typeof fetch,
    );
    await client.run({
      scope: "a",
      issueId: "SYM-1",
      repoUrl: "https://x.y/z.git",
      prompt: "p",
      engine: "pi",
      branch: "symphony/sym-1",
    });
    expect(JSON.parse(capturedBody)).toMatchObject({
      branch: "symphony/sym-1",
    });
  });

  it("omits branch from the body when null/undefined", async () => {
    let capturedBody = "";
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response("{}", { status: 200 });
    });
    const client = new DispatcherClient(
      "https://dispatcher.example",
      "k",
      fetchImpl as unknown as typeof fetch,
    );
    await client.run({
      scope: "a",
      issueId: "i",
      repoUrl: "https://x.y/z.git",
      prompt: "p",
      engine: "pi",
      branch: null,
    });
    expect(JSON.parse(capturedBody)).not.toHaveProperty("branch");
  });
});
