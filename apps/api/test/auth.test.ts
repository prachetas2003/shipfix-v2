import { describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { bearerToken, requireAdmin, requireUser, stableNumericId } from "../src/auth";

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token !== "valid-clerk-token") throw new Error("invalid");
    return { sub: "user_clerk_123", email: "user@example.com" };
  }),
}));

function request(overrides: Partial<FastifyRequest>): FastifyRequest {
  return {
    headers: {},
    query: {},
    log: { error: vi.fn() },
    ...overrides,
  } as unknown as FastifyRequest;
}

function reply() {
  const state = { statusCode: 200, body: null as unknown };
  const r = {
    status(code: number) {
      state.statusCode = code;
      return r;
    },
    send(body: unknown) {
      state.body = body;
      return r;
    },
  } as unknown as FastifyReply;
  return { reply: r, state };
}

function db(existing: unknown[] = []) {
  return {
    select: (shape: Record<string, unknown>) => {
      if ("clerkId" in shape) throw new Error("auth upsert should not select clerk_id");
      return {
      from: () => ({
        where: () => ({
          limit: async () => existing,
        }),
      }),
      };
    },
    insert: () => ({
      values: (value: { clerkId?: string; login: string }) => ({
        returning: async () => {
          if ("clerkId" in value) throw new Error("auth upsert should not insert clerk_id");
          return [{
            id: "00000000-0000-0000-0000-000000000001",
            login: value.login,
          }];
        },
      }),
    }),
    update: () => {
      throw new Error("auth upsert should not update clerk_id");
    },
  } as never;
}

function dbThatFailsOnClerkIdAccess() {
  return {
    select: (shape: Record<string, unknown>) => {
      if ("clerkId" in shape) {
        const err = new Error('column "clerk_id" of relation "users" does not exist') as Error & { code: string };
        err.code = "42703";
        throw err;
      }
      return {
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
      };
    },
    update: () => {
      throw new Error("auth upsert should not update clerk_id");
    },
    insert: () => ({
      values: (value: { clerkId?: string; login: string }) => ({
        returning: async () => {
          if ("clerkId" in value) {
            const err = new Error('column "clerk_id" of relation "users" does not exist') as Error & { code: string };
            err.code = "42703";
            throw err;
          }
          return [{
            id: "00000000-0000-0000-0000-000000000002",
            login: value.login,
          }];
        },
      }),
    }),
  } as never;
}

describe("Clerk auth helpers", () => {
  it("extracts bearer tokens only from Authorization", () => {
    expect(bearerToken(request({ headers: { authorization: "Bearer session-token" } }))).toBe("session-token");
    expect(bearerToken(request({ headers: { "x-shipfix-alpha-user": "old-token" } }))).toBeNull();
  });

  it("derives stable numeric ids from Clerk subjects", () => {
    const one = stableNumericId("clerk", "user_123");
    const two = stableNumericId("clerk", "user_123");
    const other = stableNumericId("clerk", "user_456");
    expect(one).toBe(two);
    expect(one).not.toBe(other);
    expect(Number.isSafeInteger(one)).toBe(true);
  });

  it("rejects unauthenticated Clerk requests", async () => {
    const { reply: res, state } = reply();
    const user = await requireUser(request({ headers: {} }), res, db(), {
      AUTH_MODE: "clerk",
      CLERK_SECRET_KEY: "sk_test_123",
    });
    expect(user).toBeNull();
    expect(state.statusCode).toBe(401);
    expect(state.body).toMatchObject({ error: "auth_required" });
  });

  it("accepts valid Clerk bearer tokens and upserts a scoped user", async () => {
    const { reply: res, state } = reply();
    const user = await requireUser(request({ headers: { authorization: "Bearer valid-clerk-token" } }), res, db(), {
      AUTH_MODE: "clerk",
      CLERK_SECRET_KEY: "sk_test_123",
    });
    expect(state.statusCode).toBe(200);
    expect(user).toMatchObject({ id: "00000000-0000-0000-0000-000000000001", clerkId: "user_clerk_123" });
  });

  it("does not touch clerk_id during auth upsert for older local databases", async () => {
    const { reply: res, state } = reply();
    const user = await requireUser(
      request({ headers: { authorization: "Bearer valid-clerk-token" } }),
      res,
      dbThatFailsOnClerkIdAccess(),
      {
        AUTH_MODE: "clerk",
        CLERK_SECRET_KEY: "sk_test_123",
      },
    );
    expect(state.statusCode).toBe(200);
    expect(user).toMatchObject({ id: "00000000-0000-0000-0000-000000000002", clerkId: "user_clerk_123" });
  });

  it("supports explicit dev auth outside production", async () => {
    const { reply: res } = reply();
    const user = await requireUser(request({ headers: { "x-shipfix-dev-user": "local-alice" } }), res, db(), {
      AUTH_MODE: "dev",
      CLERK_SECRET_KEY: undefined,
    });
    expect(user).toMatchObject({ clerkId: "dev:local-alice", login: "local-alice" });
  });

  it("disables admin routes when no admin token is configured", () => {
    const { reply: res, state } = reply();
    expect(requireAdmin(request({ headers: {} }), res, {})).toBe(false);
    expect(state.statusCode).toBe(404);
  });

  it("rejects incorrect admin tokens and accepts the configured token", () => {
    const wrong = reply();
    expect(
      requireAdmin(
        request({ headers: { "x-shipfix-admin-token": "wrong-token-123456" } }),
        wrong.reply,
        { SHIPFIX_ADMIN_TOKEN: "right-token-123456" },
      ),
    ).toBe(false);
    expect(wrong.state.statusCode).toBe(403);

    const right = reply();
    expect(
      requireAdmin(
        request({ headers: { "x-shipfix-admin-token": "right-token-123456" } }),
        right.reply,
        { SHIPFIX_ADMIN_TOKEN: "right-token-123456" },
      ),
    ).toBe(true);
    expect(right.state.statusCode).toBe(200);
  });
});
