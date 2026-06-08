import { createHash, timingSafeEqual } from "node:crypto";
import { verifyToken } from "@clerk/backend";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { users, type Database } from "@shipfix/db";
import type { Env } from "./env";

export type AuthenticatedUser = {
  id: string;
  clerkId: string;
  login: string;
};

const ADMIN_HEADER = "x-shipfix-admin-token";
const DEV_USER_HEADER = "x-shipfix-dev-user";

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function bearerToken(request: FastifyRequest): string | null {
  const auth = firstHeader(request.headers.authorization);
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function queryToken(request: FastifyRequest): string | null {
  const query = request.query as { token?: string } | undefined;
  return query?.token?.trim() || null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function stableNumericId(namespace: string, subject: string): number {
  const hex = createHash("sha256").update(`shipfix:${namespace}:${subject}`).digest("hex").slice(0, 13);
  return Number.parseInt(hex, 16);
}

function authMode(env: Pick<Env, "AUTH_MODE">): "clerk" | "dev" {
  return env.AUTH_MODE ?? "clerk";
}

function assertDevAuthAllowed(env: Pick<Env, "AUTH_MODE">): void {
  if (authMode(env) === "dev" && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_MODE=dev is not allowed when NODE_ENV=production.");
  }
}

async function upsertUser(
  db: Database,
  identity: { clerkId: string; login: string; email?: string | null },
): Promise<AuthenticatedUser> {
  const existing = await db.select().from(users).where(eq(users.clerkId, identity.clerkId)).limit(1);
  if (existing[0]) {
    return { id: existing[0].id, clerkId: existing[0].clerkId ?? identity.clerkId, login: existing[0].login };
  }

  const [created] = await db
    .insert(users)
    .values({
      clerkId: identity.clerkId,
      githubId: stableNumericId("clerk", identity.clerkId),
      login: identity.login,
      email: identity.email ?? null,
    })
    .returning();
  return { id: created.id, clerkId: created.clerkId ?? identity.clerkId, login: created.login };
}

async function requireDevUser(request: FastifyRequest, db: Database): Promise<AuthenticatedUser> {
  const subject = firstHeader(request.headers[DEV_USER_HEADER])?.trim() || "local-dev";
  return upsertUser(db, {
    clerkId: `dev:${subject}`,
    login: subject,
  });
}

export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  db: Database,
  env: Pick<Env, "AUTH_MODE" | "CLERK_SECRET_KEY">,
): Promise<AuthenticatedUser | null> {
  assertDevAuthAllowed(env);
  if (authMode(env) === "dev") return requireDevUser(request, db);

  if (!env.CLERK_SECRET_KEY) {
    request.log.error("CLERK_SECRET_KEY is not configured.");
    await reply.status(500).send({
      error: "auth_misconfigured",
      message: "ShipFix authentication is not configured.",
    });
    return null;
  }

  const token = bearerToken(request) || queryToken(request);
  if (!token) {
    await reply.status(401).send({
      error: "auth_required",
      message: "Please sign in to use ShipFix.",
    });
    return null;
  }

  try {
    const payload = (await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY })) as {
      sub?: string;
      email?: string;
      username?: string;
      name?: string;
    };
    if (!payload.sub) throw new Error("Clerk token missing subject.");
    return upsertUser(db, {
      clerkId: payload.sub,
      login: payload.username ?? payload.email ?? payload.name ?? payload.sub,
      email: payload.email ?? null,
    });
  } catch {
    await reply.status(401).send({
      error: "invalid_auth_token",
      message: "Your session expired. Please sign in again.",
    });
    return null;
  }
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
