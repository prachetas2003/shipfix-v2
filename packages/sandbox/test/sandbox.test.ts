import { describe, expect, it } from "vitest";
import { buildSandboxEnv, isForbiddenSandboxEnvKey } from "../src/env";
import { createRunSandboxProvider, resolveSandboxKind } from "../src/runtime";

describe("buildSandboxEnv", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/home/worker",
    SHIPFIX_MASTER_KEY: "master",
    DATABASE_URL: "postgres://control-plane",
    OPENAI_API_KEY: "sk-live",
    CLERK_SECRET_KEY: "sk_clerk",
    TEMPORAL_ADDRESS: "temporal:7233",
  };

  it("forwards only allowlisted toolchain vars from the host", () => {
    const env = buildSandboxEnv({}, host);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/worker" });
  });

  it("keeps explicit per-exec vars such as the user's own database URL", () => {
    const env = buildSandboxEnv({ DATABASE_URL: "postgres://user-db", CI: "1" }, host);
    expect(env.DATABASE_URL).toBe("postgres://user-db");
    expect(env.CI).toBe("1");
  });

  it("drops explicit vars that look like control-plane secrets", () => {
    const env = buildSandboxEnv({ SHIPFIX_MASTER_KEY: "x", ANTHROPIC_API_KEY: "y", NEON_API_KEY: "z" }, host);
    expect(env).not.toHaveProperty("SHIPFIX_MASTER_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("NEON_API_KEY");
  });

  it("classifies forbidden keys", () => {
    expect(isForbiddenSandboxEnvKey("GITHUB_APP_PRIVATE_KEY")).toBe(true);
    expect(isForbiddenSandboxEnvKey("NODE_ENV")).toBe(false);
  });
});

describe("sandbox runtime selection", () => {
  it("defaults to e2b when an API key is present", () => {
    expect(resolveSandboxKind({ E2B_API_KEY: "e2b_x" })).toBe("e2b");
    expect(resolveSandboxKind({})).toBe("local");
  });

  it("honours an explicit choice and rejects unknown values", () => {
    expect(resolveSandboxKind({ SHIPFIX_SANDBOX: "local", E2B_API_KEY: "k" })).toBe("local");
    expect(() => resolveSandboxKind({ SHIPFIX_SANDBOX: "docker" })).toThrow(/Unknown SHIPFIX_SANDBOX/);
  });

  it("refuses the host sandbox in production", () => {
    expect(() => createRunSandboxProvider({ NODE_ENV: "production" })).toThrow(/refused in production/);
  });

  it("requires an API key for e2b", () => {
    expect(() => createRunSandboxProvider({ SHIPFIX_SANDBOX: "e2b" })).toThrow(/E2B_API_KEY/);
  });

  it("builds an e2b provider without contacting E2B", () => {
    const provider = createRunSandboxProvider({ SHIPFIX_SANDBOX: "e2b", E2B_API_KEY: "e2b_test", NODE_ENV: "production" });
    expect(typeof provider.create).toBe("function");
  });
});
