import { describe, expect, it } from "vitest";
import { OAuthHelper } from "../src/lib/oauth-helper";

describe("OAuthHelper", () => {
  describe("generateState", () => {
    it("returns a 32-char hex string", () => {
      const state = OAuthHelper.generateState();
      expect(state).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe("generateAuthorizationUrl (app install)", () => {
    it("includes actor=app and app scopes", () => {
      const url = OAuthHelper.generateAuthorizationUrl(
        "client-123",
        "https://example.com/callback",
        "state-abc",
      );
      const parsed = new URL(url);
      expect(parsed.searchParams.get("actor")).toBe("app");
      expect(parsed.searchParams.get("scope")).toContain("app:assignable");
      expect(parsed.searchParams.get("scope")).toContain("app:mentionable");
      expect(parsed.searchParams.get("client_id")).toBe("client-123");
      expect(parsed.searchParams.get("state")).toBe("state-abc");
    });
  });

  describe("generateUserAuthorizationUrl", () => {
    it("omits actor param and uses only read,write scopes", () => {
      const url = OAuthHelper.generateUserAuthorizationUrl(
        "client-123",
        "https://example.com/user/callback",
        "state-xyz",
      );
      const parsed = new URL(url);
      expect(parsed.searchParams.has("actor")).toBe(false);
      expect(parsed.searchParams.get("scope")).toBe("read,write");
      expect(parsed.searchParams.get("redirect_uri")).toBe(
        "https://example.com/user/callback",
      );
      expect(parsed.searchParams.get("prompt")).toBe("consent");
    });
  });
});
