import { describe, expect, it } from "vitest";
import { decryptForOrg, encryptForOrg, type KekEnv } from "../src/lib/crypto";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * `KEK_V1` is a 256-bit hex string. We use a fixed test value so
 * round-trip tests are reproducible and tamper tests can compare
 * deterministically against a known-good blob.
 */
const KEK_HEX = "0".repeat(64);
const env: KekEnv = { KEK_V1: KEK_HEX };

describe("crypto envelope", () => {
  it("round-trips a plaintext through encrypt → decrypt", async () => {
    const blob = await encryptForOrg(env, "anthropic-sk-test-1234567890");
    expect(blob.kek_version).toBe(1);
    expect(blob.ciphertext.byteLength).toBeGreaterThan(12 + 16);
    expect(blob.dek_ciphertext.byteLength).toBe(12 + 32 + 16);

    const back = await decryptForOrg(env, blob);
    expect(back).toBe("anthropic-sk-test-1234567890");
  });

  it("produces a fresh DEK + IV per encrypt (no determinism leak)", async () => {
    const a = await encryptForOrg(env, "same-plaintext");
    const b = await encryptForOrg(env, "same-plaintext");
    expect(bytesEqual(a.ciphertext, b.ciphertext)).toBe(false);
    expect(bytesEqual(a.dek_ciphertext, b.dek_ciphertext)).toBe(false);
  });

  it("throws on tampered ciphertext (AES-GCM auth tag fails)", async () => {
    const blob = await encryptForOrg(env, "tamper-target");
    const tampered = new Uint8Array(blob.ciphertext);
    // Flip a byte well inside the AES-GCM ciphertext region so we hit
    // the auth tag check, not the IV.
    const target = Math.floor(tampered.length / 2);
    tampered[target] = (tampered[target] ?? 0) ^ 0xff;

    await expect(
      decryptForOrg(env, { ...blob, ciphertext: tampered }),
    ).rejects.toThrow();
  });

  it("throws on a wrong-version KEK (different secret value under same version)", async () => {
    const blob = await encryptForOrg(env, "key-rotated");
    const wrongEnv: KekEnv = { KEK_V1: "1".repeat(64) };
    await expect(decryptForOrg(wrongEnv, blob)).rejects.toThrow();
  });

  it("throws on a missing KEK version", async () => {
    const blob = await encryptForOrg(env, "missing-kek");
    await expect(
      decryptForOrg({} as KekEnv, blob),
    ).rejects.toThrow(/kek_unavailable/);
  });
});
