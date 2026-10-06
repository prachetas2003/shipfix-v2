import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Short-lived, run-scoped tickets for EventSource connections.
 *
 * Browsers cannot set Authorization headers on EventSource, and putting the
 * Clerk session token in the query string leaks a full-privilege credential into
 * access logs. A ticket only authorizes reading one run's stream for 60 seconds.
 * Tickets are HMAC-signed (stateless), so they work across API instances that
 * share the same signing secret.
 */

export const STREAM_TICKET_TTL_MS = 60_000;

export function streamTicketKey(secrets: Array<string | undefined>): Buffer {
  const material = secrets.filter((s): s is string => Boolean(s?.trim())).join("|");
  if (!material) return randomBytes(32);
  return createHmac("sha256", "shipfix-stream-ticket").update(material).digest();
}

function sign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function issueStreamTicket(
  key: Buffer,
  args: { userId: string; runId: string; now?: number },
): { ticket: string; expiresAt: number } {
  const expiresAt = (args.now ?? Date.now()) + STREAM_TICKET_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ u: args.userId, r: args.runId, e: expiresAt })).toString("base64url");
  return { ticket: `${payload}.${sign(key, payload)}`, expiresAt };
}

/** Returns the user id when the ticket is authentic, unexpired, and for this run. */
export function verifyStreamTicket(
  key: Buffer,
  ticket: string,
  runId: string,
  now: number = Date.now(),
): string | null {
  const [payload, signature] = ticket.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(key, payload));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: string; r?: string; e?: number };
    if (!data.u || data.r !== runId || typeof data.e !== "number" || data.e < now) return null;
    return data.u;
  } catch {
    return null;
  }
}
