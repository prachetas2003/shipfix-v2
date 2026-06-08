import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { createSecretVault, createSecretVaultFromEnv, redact } from "../src/index";

describe("SecretVault (AES-256-GCM envelope)", () => {
  const key = randomBytes(32);

  it("round-trips a secret", async () => {
    const vault = createSecretVault(key);
    const secret = "postgres://user:p@ss@ep-cool-db.neon.tech/db?sslmode=require";
    const sealed = await vault.seal(secret);
    expect(await vault.open(sealed)).toBe(secret);
  });

  it("never stores plaintext in the sealed bytes", async () => {
    const vault = createSecretVault(key);
    const secret = "super-secret-token-value";
    const sealed = await vault.seal(secret);
    const haystack = Buffer.concat([sealed.encDek, sealed.encBlob, sealed.encIv]).toString("latin1");
    expect(haystack).not.toContain(secret);
  });

  it("produces unique ciphertext per seal (random DEK + IV)", async () => {
    const vault = createSecretVault(key);
    const a = await vault.seal("same");
    const b = await vault.seal("same");
    expect(a.encBlob.equals(b.encBlob)).toBe(false);
  });

  it("fails to open with the wrong master key", async () => {
    const sealed = await createSecretVault(key).seal("x");
    const other = createSecretVault(randomBytes(32));
    await expect(other.open(sealed)).rejects.toThrow();
  });

  it("rejects a master key of the wrong length", () => {
    expect(() => createSecretVault(randomBytes(16))).toThrow(/32 bytes/);
  });

  it("reads a base64 master key from the environment", async () => {
    const vault = createSecretVaultFromEnv({ SHIPFIX_MASTER_KEY: key.toString("base64") } as NodeJS.ProcessEnv);
    const sealed = await vault.seal("hello");
    expect(await vault.open(sealed)).toBe("hello");
  });

  it("throws a clear error when the env key is missing", () => {
    expect(() => createSecretVaultFromEnv({} as NodeJS.ProcessEnv)).toThrow(/SHIPFIX_MASTER_KEY/);
  });
});

describe("redact", () => {
  it("redacts common LLM keys, JWTs, private keys, and sensitive assignments", () => {
    const input = [
      "OPENAI_API_KEY=sk-" + "a".repeat(30),
      "ANTHROPIC_API_KEY=sk-ant-" + "b".repeat(30),
      "GEMINI_API_KEY=AIza" + "c".repeat(30),
      "DATABASE_URL=postgres://u:p@host/db",
      "JWT_SECRET=supersecret",
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      "eyJ" + "a".repeat(25) + "." + "b".repeat(25) + "." + "c".repeat(12),
    ].join("\n");
    const out = redact(input);
    expect(out).not.toContain("sk-");
    expect(out).not.toContain("sk-ant-");
    expect(out).not.toContain("AIza");
    expect(out).not.toContain("postgres://");
    expect(out).not.toContain("supersecret");
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).not.toContain("eyJ");
    expect(out).toContain("[REDACTED]");
  });
});
