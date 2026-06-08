import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { users, type Database } from "@shipfix/db";
import type { Env } from "./env";

export type AlphaUserToken = {
  login: string;
  token: string;
};

export type AlphaUser = {
  id: string;
  login: string;
};

const USER_HEADER = "x-shipfix-alpha-user";
const ADMIN_HEADER = "x-shipfix-admin-token";

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function bearerToken(request: FastifyRequest): string | null {
  const auth = firstHeader(request.headers.authorization);
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function parseAlphaUserTokens(raw: string | undefined): AlphaUserToken[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [login, ...tokenParts] = entry.split(":");
      return { login: login?.trim() ?? "", token: tokenParts.join(":").trim() };
    })
    .filter((entry) => entry.login.length > 0 && entry.token.length >= 16);
}

export function alphaUserNumericId(token: string): number {
  const hex = createHash("sha256").update(`shipfix-alpha-user:${token}`).digest("hex").slice(0, 13);
  return Number.parseInt(hex, 16);
}

export function resolveAlphaToken(request: FastifyRequest): string | null {
  const query = request.query as { alpha_token?: string } | undefined;
  return firstHeader(request.headers[USER_HEADER])?.trim() || bearerToken(request) || query?.alpha_token?.trim() || null;
}

export async function requireAlphaUser(
  request: FastifyRequest,
  reply: FastifyReply,
  db: Database,
  env: Pick<Env, "ALPHA_USER_TOKENS">,
): Promise<AlphaUser | null> {
  const supplied = resolveAlphaToken(request);
  const configured = parseAlphaUserTokens(env.ALPHA_USER_TOKENS);
  const matched = configured.find((entry) => supplied && constantTimeEquals(supplied, entry.token));
  if (!matched) {
    await reply.status(401).send({
      error: "alpha_auth_required",
      message: "ShipFix alpha requires an access token. Add your alpha token and try again.",
    });
    return null;
  }

  const githubId = alphaUserNumericId(matched.token);
  const existing = await db.select().from(users).where(eq(users.githubId, githubId)).limit(1);
  if (existing[0]) return { id: existing[0].id, login: existing[0].login };

  const [created] = await db
    .insert(users)
    .values({ githubId, login: matched.login })
    .returning();
  return { id: created.id, login: created.login };
}

export function requireAdmin(request: FastifyRequest, reply: FastifyReply, env: Pick<Env, "SHIPFIX_ADMIN_TOKEN">): boolean {
  if (!env.SHIPFIX_ADMIN_TOKEN) {
    void reply.status(404).send({ error: "not_found" });
    return false;
  }
  const supplied = firstHeader(request.headers[ADMIN_HEADER])?.trim() || bearerToken(request);
  if (!supplied || !constantTimeEquals(supplied, env.SHIPFIX_ADMIN_TOKEN)) {
    void reply.status(403).send({ error: "admin_forbidden", message: "Admin access is required." });
    return false;
  }
  return true;
}
