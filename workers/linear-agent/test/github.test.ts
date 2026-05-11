import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubError,
  addLabels,
  createPr,
  parseRepoUrl,
} from "../src/lib/github";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRepoUrl", () => {
  it("handles .git-suffixed https URLs", () => {
    expect(parseRepoUrl("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("handles bare https URLs without .git", () => {
    expect(parseRepoUrl("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("rejects ssh-style URLs (item 4 uses HTTPS PAT)", () => {
    expect(() => parseRepoUrl("git@github.com:owner/repo.git")).toThrow(
      /invalid_github_repo_url/,
    );
  });

  it("rejects non-github hosts", () => {
    expect(() => parseRepoUrl("https://gitlab.com/owner/repo")).toThrow();
  });
});

describe("createPr", () => {
  it("POSTs to /repos/.../pulls and returns the html_url + number", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      expect(url).toBe("https://api.github.com/repos/markoinla/symphony/pulls");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({
        title: "Symphony: SYM-1",
        head: "linear/sym-1",
        base: "main",
      });
      return new Response(
        JSON.stringify({
          html_url: "https://github.com/markoinla/symphony/pull/42",
          number: 42,
        }),
        { status: 201 },
      );
    });

    const result = await createPr({
      repoUrl: "https://github.com/markoinla/symphony.git",
      branch: "linear/sym-1",
      title: "Symphony: SYM-1",
      body: "fixes",
      token: "ghp_abc",
    });
    expect(result).toEqual({
      url: "https://github.com/markoinla/symphony/pull/42",
      number: 42,
    });
  });

  it("falls back to existing PR lookup on GitHub 422 (already exists)", async () => {
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      call++;
      const url = typeof input === "string" ? input : (input as Request).url;
      if (call === 1) {
        expect(url).toContain("/pulls");
        expect(url).not.toContain("?head=");
        return new Response(
          JSON.stringify({ message: "A pull request already exists" }),
          { status: 422 },
        );
      }
      // 2nd call is the lookup.
      expect(url).toContain("?head=");
      return new Response(
        JSON.stringify([
          {
            html_url: "https://github.com/owner/repo/pull/7",
            number: 7,
          },
        ]),
        { status: 200 },
      );
    });

    const result = await createPr({
      repoUrl: "https://github.com/owner/repo",
      branch: "linear/sym-7",
      title: "x",
      body: "y",
      token: "t",
    });
    expect(result).toEqual({
      url: "https://github.com/owner/repo/pull/7",
      number: 7,
    });
  });

  it("throws GitHubError on non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
        }),
    );

    await expect(
      createPr({
        repoUrl: "https://github.com/o/r",
        branch: "b",
        title: "t",
        body: "y",
        token: "bad",
      }),
    ).rejects.toBeInstanceOf(GitHubError);
  });
});

describe("addLabels", () => {
  it("POSTs to /repos/.../issues/<n>/labels with the label array", async () => {
    const captured: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      captured.push({ url, body: JSON.parse(init?.body as string) });
      return new Response("[]", { status: 200 });
    });

    await addLabels({
      repoUrl: "https://github.com/owner/repo.git",
      prNumber: 42,
      labels: ["symphony"],
      token: "ghp_abc",
    });

    expect(captured[0]?.url).toBe(
      "https://api.github.com/repos/owner/repo/issues/42/labels",
    );
    expect(captured[0]?.body).toEqual({ labels: ["symphony"] });
  });
});
