const HEADER_BLOCK = {
  source: "/(.*)",
  headers: [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  ],
};

const ALREADY_RE = /x-frame-options|content-security-policy|strict-transport-security/i;

/**
 * Add a basic header block to vercel.json. Returns null when the file is not
 * JSON, and changed: false when headers are already present.
 */
export function withSecurityHeaders(raw: string | null): { content: string; changed: boolean } | null {
  let doc: Record<string, unknown> = {};
  if (raw != null && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      doc = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (ALREADY_RE.test(JSON.stringify(doc))) return { content: raw ?? "", changed: false };
  const existing = Array.isArray(doc.headers) ? doc.headers : [];
  doc.headers = [...existing, HEADER_BLOCK];
  return { content: `${JSON.stringify(doc, null, 2)}\n`, changed: true };
}
