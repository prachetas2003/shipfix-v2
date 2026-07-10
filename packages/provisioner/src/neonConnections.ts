/**
 * Neon connection URL roles.
 *
 * Prisma migrate (and similar) need a **direct** (non-pooler) URL.
 * Runtime app connections should use the **pooled** URL when Neon provides one.
 *
 * Secrets are stored as JSON `{ "pooled": "...", "direct": "..." }` so both
 * roles survive sealing. Plain postgres URL strings remain accepted for
 * backward compatibility with resources provisioned before this change.
 */

export interface NeonConnectionUrls {
  pooled: string;
  direct: string;
  /** True when Neon only returned one URI — both roles share it. */
  singleUri: boolean;
}

const POOLER_HOST_RE = /-pooler\./i;

export function isPoolerUri(uri: string): boolean {
  try {
    return POOLER_HOST_RE.test(new URL(uri).hostname);
  } catch {
    return /pooler/i.test(uri);
  }
}

/** Pick pooled + direct URLs from Neon `connection_uris` values. */
export function selectNeonConnectionUrls(uris: string[]): NeonConnectionUrls | null {
  const cleaned = uris.map((u) => u.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;

  const pooled = cleaned.find(isPoolerUri);
  const direct = cleaned.find((u) => !isPoolerUri(u));

  if (pooled && direct) {
    return { pooled, direct, singleUri: false };
  }
  if (cleaned.length === 1) {
    const only = cleaned[0]!;
    return { pooled: only, direct: only, singleUri: true };
  }
  // Multiple URIs but classification failed — prefer first as both.
  const only = cleaned[0]!;
  return { pooled: pooled ?? only, direct: direct ?? only, singleUri: !pooled || !direct };
}

export function serializeNeonConnectionSecret(urls: NeonConnectionUrls): string {
  return JSON.stringify({ pooled: urls.pooled, direct: urls.direct });
}

/**
 * Open a sealed managed DB secret into connection roles.
 * Accepts legacy plain URL strings and JSON payloads.
 */
export function parseNeonConnectionSecret(secret: string): NeonConnectionUrls {
  const trimmed = secret.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { pooled?: unknown; direct?: unknown };
      const pooled = typeof parsed.pooled === "string" ? parsed.pooled : null;
      const direct = typeof parsed.direct === "string" ? parsed.direct : null;
      if (pooled && direct) {
        return { pooled, direct, singleUri: pooled === direct };
      }
      if (pooled) return { pooled, direct: pooled, singleUri: true };
      if (direct) return { pooled: direct, direct, singleUri: true };
    } catch {
      // fall through to plain URL
    }
  }
  return { pooled: trimmed, direct: trimmed, singleUri: true };
}

export function runtimeConnectionUrl(urls: NeonConnectionUrls): string {
  return urls.pooled;
}

export function migrateConnectionUrl(urls: NeonConnectionUrls): string {
  return urls.direct;
}
