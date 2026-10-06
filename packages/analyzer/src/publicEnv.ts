import type { PublicEnvValue } from "@shipfix/contracts";
import type { RepoSource } from "./source";
import { baseOf, nearestRoot } from "./util";

/**
 * Committed env files whose values ARE the app's config. `.env.example` and
 * friends hold placeholders, and `.env.local` / `.env.development` are dev-only.
 */
const COMMITTED_ENV_FILES = new Set([".env", ".env.production"]);

/** Prefixes frameworks inline into the client bundle — public by definition. */
export const PUBLIC_ENV_PREFIX_RE = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)/;

const PLACEHOLDER_RE = /(your[-_ ]|xxx|<[^>]*>|changeme|change[-_]me|example\.com|placeholder|replace[-_ ]?me|\.\.\.)/i;

/** Credential shapes that must never be treated as public, whatever the name says. */
const SECRET_VALUE_RES: RegExp[] = [
  /^sb_secret_/,
  /^(sk|rk)_(live|test)_/,
  /^whsec_/,
  /^gh[pousr]_[A-Za-z0-9]{20,}/,
  /^github_pat_/,
  /^xox[abpr]-/,
  /^AKIA[0-9A-Z]{16}$/,
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^(postgres(ql)?|mysql|mongodb(\+srv)?|redis|rediss):\/\/[^/\s]*:[^@\s]+@/i,
];

function jwtRole(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 3 || !value.startsWith("eyJ")) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

export function isSafePublicValue(value: string): boolean {
  if (!value || value.length > 2048 || PLACEHOLDER_RE.test(value)) return false;
  if (SECRET_VALUE_RES.some((re) => re.test(value))) return false;
  const role = jwtRole(value);
  if (role && role !== "anon" && role !== "authenticated") return false; // e.g. Supabase service_role
  return true;
}

function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = value.match(/^(['"])(.*)\1$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "");
    out.set(m[1], value);
  }
  return out;
}

/**
 * Read browser-public values from committed env files (Lovable and Bolt
 * commit `.env` with the Supabase URL and publishable key). Anything that is
 * not public-prefixed, looks like a placeholder, or looks like a credential is
 * dropped — this never surfaces a secret.
 */
export async function detectPublicEnv(
  source: RepoSource,
  files: ReadonlySet<string>,
  serviceRoots: string[],
): Promise<PublicEnvValue[]> {
  const found: PublicEnvValue[] = [];
  for (const file of files) {
    if (!COMMITTED_ENV_FILES.has(baseOf(file))) continue;
    const text = await source.readFile(file);
    if (!text) continue;
    const service = nearestRoot(file, serviceRoots);
    for (const [name, value] of parseDotenv(text)) {
      if (!PUBLIC_ENV_PREFIX_RE.test(name) || !isSafePublicValue(value)) continue;
      found.push({ name, value, file, service });
    }
  }
  // `.env.production` wins over `.env` for the same service + name.
  const byKey = new Map<string, PublicEnvValue>();
  for (const v of found.sort((a, b) => a.file.localeCompare(b.file))) {
    const key = `${v.service}\u0000${v.name}`;
    const prev = byKey.get(key);
    if (!prev || baseOf(v.file) === ".env.production") byKey.set(key, v);
  }
  return [...byKey.values()].sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
}
