/**
 * @shipfix/secrets — the redaction + envelope-encryption boundary.
 *
 * Two hard rules this package exists to enforce:
 *  1. No secret VALUE is ever logged, stored in plaintext, or sent to an LLM.
 *  2. Anything leaving the trusted control plane (logs, run_events, LLM prompts)
 *     passes through `redact()` first.
 */

/**
 * Patterns for common credential shapes. Intentionally conservative — false
 * positives (over-redaction) are acceptable; leaks are not.
 *
 * TODO: port and expand the battle-tested pattern set from v1
 * `packages/shared/src/redactSecrets.ts` (GitHub/Vercel/Render/Gemini tokens,
 * DB URLs, Supabase keys, x-access-token URLs).
 */
const REDACTION_PATTERNS: RegExp[] = [
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g, // Anthropic-style
  /\bAIza[A-Za-z0-9_\-]{20,}\b/g, // Google API key
  /\bpostgres(?:ql)?:\/\/[^\s'"]+/g, // Postgres connection strings
  /\b(mysql|redis):\/\/[^\s'"]+/g,
  /\bx-access-token:[^@\s]+@/g, // tokenized git remote
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\b/g, // JWT
  /\b(?:DATABASE_URL|JWT_SECRET|SESSION_SECRET|SECRET_KEY|API_KEY|TOKEN|PASSWORD|PRIVATE_KEY)\b\s*[:=]\s*["']?[^"',\s}]+["']?/gi,
];

const REDACTED = "[REDACTED]";

/** Redact secrets from an arbitrary string before it is logged or persisted. */
export function redact(input: string): string {
  let out = input;
  for (const pattern of REDACTION_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Deep-redact a structured value (for run_events `data` payloads). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

// ── Envelope encryption ──────────────────────────────────────────────────────

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface SealedSecret {
  /** Master-key-wrapped data key: wrapIv(12) ‖ wrapTag(16) ‖ wrappedDek(32). */
  encDek: Buffer;
  /** DEK-encrypted payload: tag(16) ‖ ciphertext. */
  encBlob: Buffer;
  /** IV for the payload encryption (12 bytes). */
  encIv: Buffer;
}

export interface SecretVault {
  /** Encrypt a plaintext secret using a fresh data key wrapped by the master key. */
  seal(plaintext: string): Promise<SealedSecret>;
  /** Decrypt just-in-time inside the trusted control plane. */
  open(sealed: SealedSecret): Promise<string>;
}

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function gcmEncrypt(key: Buffer, plaintext: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

function gcmDecrypt(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer {
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Envelope-encryption vault backed by a 32-byte master key.
 *
 * Real AES-256-GCM with a per-secret data key (DEK) wrapped by the master key —
 * the same shape as a KMS deployment, just with the master key held locally.
 * Swap `createSecretVault` for a KMS-backed wrap/unwrap of the DEK in prod
 * WITHOUT changing callers or the `{encDek, encBlob, encIv}` storage layout.
 */
export function createSecretVault(masterKey: Buffer): SecretVault {
  if (masterKey.length !== KEY_LEN) {
    throw new Error(`SecretVault master key must be ${KEY_LEN} bytes, got ${masterKey.length}.`);
  }
  return {
    async seal(plaintext: string): Promise<SealedSecret> {
      const dek = randomBytes(KEY_LEN);
      const blob = gcmEncrypt(dek, Buffer.from(plaintext, "utf8"));
      const wrap = gcmEncrypt(masterKey, dek);
      return {
        encDek: Buffer.concat([wrap.iv, wrap.tag, wrap.ct]),
        encBlob: Buffer.concat([blob.tag, blob.ct]),
        encIv: blob.iv,
      };
    },
    async open(sealed: SealedSecret): Promise<string> {
      const wrapIv = sealed.encDek.subarray(0, IV_LEN);
      const wrapTag = sealed.encDek.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const wrappedDek = sealed.encDek.subarray(IV_LEN + TAG_LEN);
      const dek = gcmDecrypt(masterKey, wrapIv, wrapTag, wrappedDek);

      const blobTag = sealed.encBlob.subarray(0, TAG_LEN);
      const blobCt = sealed.encBlob.subarray(TAG_LEN);
      return gcmDecrypt(dek, sealed.encIv, blobTag, blobCt).toString("utf8");
    },
  };
}

/**
 * Build a vault from `SHIPFIX_MASTER_KEY` (base64, 32 bytes). Throws a clear,
 * actionable error if unset/invalid — there is no insecure fallback.
 * Generate one for dev with: `openssl rand -base64 32`.
 */
export function createSecretVaultFromEnv(env: NodeJS.ProcessEnv = process.env): SecretVault {
  const raw = env.SHIPFIX_MASTER_KEY;
  if (!raw) {
    throw new Error(
      "SHIPFIX_MASTER_KEY is not set. Generate one with `openssl rand -base64 32` and add it to .env.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LEN) {
    throw new Error(
      `SHIPFIX_MASTER_KEY must decode to ${KEY_LEN} bytes (base64). Got ${key.length}.`,
    );
  }
  return createSecretVault(key);
}
