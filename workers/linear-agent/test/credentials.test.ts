import { describe, expect, it } from "vitest";
import {
  CredentialStore,
  CURRENT_KEK_VERSION,
} from "../src/lib/credentials";
import { FakeD1 } from "./helpers/fake-d1";

async function generateKekBase64(): Promise<string> {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["wrapKey", "unwrapKey"],
  ) as CryptoKey;
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

describe("CredentialStore", () => {
  it("round-trips: encrypt then decrypt returns original plaintext", async () => {
    const db = new FakeD1();
    const store = new CredentialStore(db as unknown as D1Database);
    const kek = await generateKekBase64();

    await store.encryptForOrg("org-1", "anthropic_api_key", "sk-ant-secret-123", kek);
    const result = await store.decryptForOrg("org-1", "anthropic_api_key", kek);

    expect(result).toBe("sk-ant-secret-123");
  });

  it("returns null for a missing credential row", async () => {
    const db = new FakeD1();
    const store = new CredentialStore(db as unknown as D1Database);
    const kek = await generateKekBase64();

    const result = await store.decryptForOrg("org-1", "nonexistent", kek);
    expect(result).toBeNull();
  });

  it("detects tampering in ciphertext (auth-tag failure)", async () => {
    const db = new FakeD1();
    const store = new CredentialStore(db as unknown as D1Database);
    const kek = await generateKekBase64();

    await store.encryptForOrg("org-1", "openai_api_key", "sk-openai-secret", kek);

    const row = db.orgCredentials.get("org-1:openai_api_key")!;
    const tampered = new Uint8Array(row.ciphertext);
    tampered[tampered.length - 1] ^= 0xff;
    row.ciphertext = tampered.buffer;

    await expect(
      store.decryptForOrg("org-1", "openai_api_key", kek),
    ).rejects.toThrow();
  });

  it("detects tampering in wrapped DEK", async () => {
    const db = new FakeD1();
    const store = new CredentialStore(db as unknown as D1Database);
    const kek = await generateKekBase64();

    await store.encryptForOrg("org-1", "cf_token", "my-cf-token", kek);

    const row = db.orgCredentials.get("org-1:cf_token")!;
    const tampered = new Uint8Array(row.dek_ciphertext);
    tampered[tampered.length - 1] ^= 0xff;
    row.dek_ciphertext = tampered.buffer;

    await expect(
      store.decryptForOrg("org-1", "cf_token", kek),
    ).rejects.toThrow();
  });

  it("supports multiple credential kinds per org", async () => {
    const db = new FakeD1();
    const store = new CredentialStore(db as unknown as D1Database);
    const kek = await generateKekBase64();

    await store.encryptForOrg("org-1", "anthropic_api_key", "sk-ant", kek);
    await store.encryptForOrg("org-1", "openai_api_key", "sk-oai", kek);
    await store.encryptForOrg("org-1", "cf_api_token", "cf-tok", kek);

    expect(await store.decryptForOrg("org-1", "anthropic_api_key", kek)).toBe("sk-ant");
    expect(await store.decryptForOrg("org-1", "openai_api_key", kek)).toBe("sk-oai");
    expect(await store.decryptForOrg("org-1", "cf_api_token", kek)).toBe("cf-tok");
  });

  it("isolates credentials between orgs", async () => {
    const db = new FakeD1();
    const store = new CredentialStore(db as unknown as D1Database);
    const kek = await generateKekBase64();

    await store.encryptForOrg("org-1", "anthropic_api_key", "secret-1", kek);
    await store.encryptForOrg("org-2", "anthropic_api_key", "secret-2", kek);

    expect(await store.decryptForOrg("org-1", "anthropic_api_key", kek)).toBe("secret-1");
    expect(await store.decryptForOrg("org-2", "anthropic_api_key", kek)).toBe("secret-2");
  });

  it("stores kek_version correctly", async () => {
    const db = new FakeD1();
    const store = new CredentialStore(db as unknown as D1Database);
    const kek = await generateKekBase64();

    await store.encryptForOrg("org-1", "test_key", "value", kek, 3);

    const row = db.orgCredentials.get("org-1:test_key")!;
    expect(row.kek_version).toBe(3);
  });

  it("defaults kek_version to CURRENT_KEK_VERSION", async () => {
    const db = new FakeD1();
    const store = new CredentialStore(db as unknown as D1Database);
    const kek = await generateKekBase64();

    await store.encryptForOrg("org-1", "test_key", "value", kek);

    const row = db.orgCredentials.get("org-1:test_key")!;
    expect(row.kek_version).toBe(CURRENT_KEK_VERSION);
  });

  it("overwrites credential on re-encrypt (upsert)", async () => {
    const db = new FakeD1();
    const store = new CredentialStore(db as unknown as D1Database);
    const kek = await generateKekBase64();

    await store.encryptForOrg("org-1", "anthropic_api_key", "old-key", kek);
    await store.encryptForOrg("org-1", "anthropic_api_key", "new-key", kek);

    expect(await store.decryptForOrg("org-1", "anthropic_api_key", kek)).toBe("new-key");
  });

  it("delete removes a credential and returns true", async () => {
    const db = new FakeD1();
    const store = new CredentialStore(db as unknown as D1Database);
    const kek = await generateKekBase64();

    await store.encryptForOrg("org-1", "api_key", "secret", kek);
    expect(await store.delete("org-1", "api_key")).toBe(true);
    expect(await store.decryptForOrg("org-1", "api_key", kek)).toBeNull();
    expect(await store.delete("org-1", "api_key")).toBe(false);
  });

  it("listKinds returns sorted credential kinds for an org", async () => {
    const db = new FakeD1();
    const store = new CredentialStore(db as unknown as D1Database);
    const kek = await generateKekBase64();

    await store.encryptForOrg("org-1", "openai_api_key", "v1", kek);
    await store.encryptForOrg("org-1", "anthropic_api_key", "v2", kek);
    await store.encryptForOrg("org-2", "cf_token", "v3", kek);

    const kinds = await store.listKinds("org-1");
    expect(kinds).toEqual(["anthropic_api_key", "openai_api_key"]);
  });

  it("fails decryption with wrong KEK", async () => {
    const db = new FakeD1();
    const store = new CredentialStore(db as unknown as D1Database);
    const kek1 = await generateKekBase64();
    const kek2 = await generateKekBase64();

    await store.encryptForOrg("org-1", "api_key", "secret", kek1);

    await expect(
      store.decryptForOrg("org-1", "api_key", kek2),
    ).rejects.toThrow();
  });

  it("handles empty string plaintext", async () => {
    const db = new FakeD1();
    const store = new CredentialStore(db as unknown as D1Database);
    const kek = await generateKekBase64();

    await store.encryptForOrg("org-1", "empty", "", kek);
    expect(await store.decryptForOrg("org-1", "empty", kek)).toBe("");
  });

  it("handles large plaintext values", async () => {
    const db = new FakeD1();
    const store = new CredentialStore(db as unknown as D1Database);
    const kek = await generateKekBase64();

    const large = "x".repeat(10_000);
    await store.encryptForOrg("org-1", "big", large, kek);
    expect(await store.decryptForOrg("org-1", "big", kek)).toBe(large);
  });
});
