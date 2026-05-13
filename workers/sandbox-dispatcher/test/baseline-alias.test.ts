import { describe, expect, it } from "vitest";
import { resolveBaselineEngine } from "../src/baseline-alias";

describe("resolveBaselineEngine", () => {
  it("maps known engines to their shared baseline row", () => {
    expect(resolveBaselineEngine("pi")).toBe("pi");
    expect(resolveBaselineEngine("claude")).toBe("pi");
  });

  it("passes unknown engines through unchanged so SUPPORTED_ENGINES is the gate", () => {
    expect(resolveBaselineEngine("codex")).toBe("codex");
    expect(resolveBaselineEngine("nonsense")).toBe("nonsense");
  });
});
