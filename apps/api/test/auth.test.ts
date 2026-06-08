import { describe, expect, it } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  alphaUserNumericId,
  parseAlphaUserTokens,
  requireAdmin,
  resolveAlphaToken,
} from "../src/auth";

function request(overrides: Partial<FastifyRequest>): FastifyRequest {
  return {
    headers: {},
    query: {},
    ...overrides,
  } as FastifyRequest;
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

describe("alpha auth helpers", () => {
  it("parses configured alpha users and ignores weak entries", () => {
    expect(parseAlphaUserTokens("alice:1234567890123456, broken, bob:abcdefghijklmnopqrstuvwxyz")).toEqual([
      { login: "alice", token: "1234567890123456" },
      { login: "bob", token: "abcdefghijklmnopqrstuvwxyz" },
    ]);
  });

  it("derives a stable numeric user id from the token without exposing the token", () => {
    const one = alphaUserNumericId("token-for-alice-123456");
    const two = alphaUserNumericId("token-for-alice-123456");
    const other = alphaUserNumericId("token-for-bob-123456");
    expect(one).toBe(two);
    expect(one).not.toBe(other);
    expect(Number.isSafeInteger(one)).toBe(true);
  });

  it("resolves alpha tokens from header, bearer auth, or SSE query", () => {
    expect(resolveAlphaToken(request({ headers: { "x-shipfix-alpha-user": "from-header" } }))).toBe("from-header");
    expect(resolveAlphaToken(request({ headers: { authorization: "Bearer from-bearer" } }))).toBe("from-bearer");
    expect(resolveAlphaToken(request({ query: { alpha_token: "from-query" } }))).toBe("from-query");
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

