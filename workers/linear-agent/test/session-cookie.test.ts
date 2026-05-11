import { describe, expect, it } from "vitest";
import {
  buildClearCookie,
  buildSessionCookie,
  readSessionFromRequest,
  type SessionEnv,
} from "../src/lib/session-cookie";

const env: SessionEnv = { DASHBOARD_COOKIE_SECRET: "test-secret-32-bytes-or-more__" };

function makeRequest(cookieHeader: string | null): Request {
  const headers = new Headers();
  if (cookieHeader) headers.set("cookie", cookieHeader);
  return new Request("https://example/", { headers });
}

describe("session cookie", () => {
  it("round-trips a payload through signed cookie", async () => {
    const cookie = await buildSessionCookie(
      env,
      { uid: "u-1", oid: "org-1" },
      { secure: false },
    );
    const value = cookie.split(";")[0]!;
    const req = makeRequest(value);

    const payload = await readSessionFromRequest(env, req);
    expect(payload?.uid).toBe("u-1");
    expect(payload?.oid).toBe("org-1");
    expect(payload?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects a cookie signed with a different secret", async () => {
    const cookie = await buildSessionCookie(
      env,
      { uid: "u-1", oid: "org-1" },
      { secure: false },
    );
    const value = cookie.split(";")[0]!;
    const req = makeRequest(value);

    const wrongEnv: SessionEnv = { DASHBOARD_COOKIE_SECRET: "different-secret" };
    expect(await readSessionFromRequest(wrongEnv, req)).toBeNull();
  });

  it("rejects an expired payload", async () => {
    const cookie = await buildSessionCookie(
      env,
      { uid: "u-1", oid: "org-1", exp: 1 },
      { secure: false },
    );
    const value = cookie.split(";")[0]!;
    const req = makeRequest(value);
    expect(await readSessionFromRequest(env, req)).toBeNull();
  });

  it("returns null when no cookie header is present", async () => {
    const req = makeRequest(null);
    expect(await readSessionFromRequest(env, req)).toBeNull();
  });

  it("buildClearCookie zeros Max-Age", () => {
    expect(buildClearCookie()).toContain("Max-Age=0");
  });

  it("Set-Cookie shape includes HttpOnly and SameSite=Lax", async () => {
    const cookie = await buildSessionCookie(env, { uid: "u-1", oid: "org-1" });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });
});
