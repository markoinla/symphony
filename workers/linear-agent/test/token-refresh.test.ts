import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  refreshOAuthToken,
  tokenNeedsRefresh,
  OAuthRefreshError,
} from "../src/lib/token-refresh";

describe("tokenNeedsRefresh", () => {
  it("returns false when expiresAt is null", () => {
    expect(tokenNeedsRefresh(null, 600_000)).toBe(false);
  });

  it("returns false when expiresAt is far in the future", () => {
    const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(tokenNeedsRefresh(farFuture, 600_000)).toBe(false);
  });

  it("returns true when expiresAt is within run_timeout + safety_margin", () => {
    const soonExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    expect(tokenNeedsRefresh(soonExpiry, 600_000, 300_000)).toBe(true);
  });

  it("returns true when expiresAt is in the past", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(tokenNeedsRefresh(past, 600_000)).toBe(true);
  });

  it("returns false for invalid date string", () => {
    expect(tokenNeedsRefresh("not-a-date", 600_000)).toBe(false);
  });

  it("uses default safety margin of 5 minutes", () => {
    const expiresIn14Min = new Date(
      Date.now() + 14 * 60 * 1000,
    ).toISOString();
    expect(tokenNeedsRefresh(expiresIn14Min, 10 * 60 * 1000)).toBe(true);

    const expiresIn16Min = new Date(
      Date.now() + 16 * 60 * 1000,
    ).toISOString();
    expect(tokenNeedsRefresh(expiresIn16Min, 10 * 60 * 1000)).toBe(false);
  });
});

describe("refreshOAuthToken", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends correct request to Linear token endpoint", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body ?? "");
      capturedHeaders = Object.fromEntries(
        Object.entries(init?.headers ?? {}),
      );
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await refreshOAuthToken({
      refreshToken: "old-refresh",
      clientId: "client-id",
      clientSecret: "client-secret",
    });

    expect(capturedUrl).toBe("https://api.linear.app/oauth/token");
    expect(capturedHeaders["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const params = new URLSearchParams(capturedBody);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("old-refresh");
    expect(params.get("client_id")).toBe("client-id");
    expect(params.get("client_secret")).toBe("client-secret");
  });

  it("returns parsed tokens and computed expiresAt", async () => {
    const beforeMs = Date.now();

    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "fresh-token",
          refresh_token: "fresh-refresh",
          expires_in: 7200,
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const result = await refreshOAuthToken({
      refreshToken: "old",
      clientId: "c",
      clientSecret: "s",
    });

    expect(result.accessToken).toBe("fresh-token");
    expect(result.refreshToken).toBe("fresh-refresh");
    expect(result.expiresAt).not.toBeNull();
    const expiresMs = new Date(result.expiresAt!).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(beforeMs + 7200 * 1000 - 1000);
    expect(expiresMs).toBeLessThanOrEqual(beforeMs + 7200 * 1000 + 5000);
  });

  it("uses custom tokenUrl when provided", async () => {
    let capturedUrl = "";

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({ access_token: "tok" }),
        { status: 200 },
      );
    }) as typeof fetch;

    await refreshOAuthToken({
      refreshToken: "r",
      clientId: "c",
      clientSecret: "s",
      tokenUrl: "https://custom.example.com/oauth/token",
    });

    expect(capturedUrl).toBe("https://custom.example.com/oauth/token");
  });

  it("throws OAuthRefreshError on non-200 response", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("invalid_grant", { status: 400 }),
    ) as typeof fetch;

    await expect(
      refreshOAuthToken({
        refreshToken: "expired",
        clientId: "c",
        clientSecret: "s",
      }),
    ).rejects.toThrow(OAuthRefreshError);
  });

  it("throws OAuthRefreshError when response lacks access_token", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200 }),
    ) as typeof fetch;

    await expect(
      refreshOAuthToken({
        refreshToken: "r",
        clientId: "c",
        clientSecret: "s",
      }),
    ).rejects.toThrow("missing_access_token_in_response");
  });

  it("handles missing refresh_token and expires_in in response", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "tok-only" }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const result = await refreshOAuthToken({
      refreshToken: "r",
      clientId: "c",
      clientSecret: "s",
    });

    expect(result.accessToken).toBe("tok-only");
    expect(result.refreshToken).toBeNull();
    expect(result.expiresAt).toBeNull();
  });
});
