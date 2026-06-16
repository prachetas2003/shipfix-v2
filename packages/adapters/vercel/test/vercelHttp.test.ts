import { describe, it, expect } from "vitest";
import { classifyVercelFailure } from "../src/vercelHttp";

describe("classifyVercelFailure", () => {
  it("detects GitHub login connection setup blocker", () => {
    const body = JSON.stringify({
      error: {
        code: "bad_request",
        message: "Failed to link acme/repo. You need to add a Login Connection to your GitHub account first.",
        link: "https://vercel.com/docs/accounts/create-an-account#login-methods-and-connections",
      },
    });
    const result = classifyVercelFailure(400, "Bad Request", body);
    expect(result.kind).toBe("setup_blocker");
    expect(result.message).toContain("GitHub connection required");
    expect(result.message).toContain("Login Connection");
  });

  it("returns deploy_failed for other API errors", () => {
    const result = classifyVercelFailure(500, "Internal Server Error", "upstream error");
    expect(result.kind).toBe("deploy_failed");
    expect(result.message).toContain("HTTP 500");
  });

  it("detects gitSource repoId setup blocker from API 400", () => {
    const body = JSON.stringify({
      error: {
        code: "bad_request",
        message: "Invalid request: `gitSource` missing required property `repoId`.",
      },
    });
    const result = classifyVercelFailure(400, "Bad Request", body);
    expect(result.kind).toBe("setup_blocker");
    expect(result.message).toContain("repoId");
  });

  it("classifies repository connection limit as provider_limit", () => {
    const body = JSON.stringify({
      error: {
        code: "bad_request",
        message: "A Git Repository cannot be connected to more than 10 Projects.",
        link: "https://vercel.link/repository-connection-limit",
      },
    });
    const result = classifyVercelFailure(400, "Bad Request", body);
    expect(result.kind).toBe("provider_limit");
    expect(result.message).toContain("too many Vercel projects");
    expect(result.message).not.toContain("repo script");
  });

  it("classifies duplicate env var errors as provider_env_conflict", () => {
    const body = JSON.stringify({
      error: {
        code: "bad_request",
        message:
          "A variable with the name `VITE_API_URL` already exists for the target production,preview on branch undefined",
      },
    });
    const result = classifyVercelFailure(400, "Bad Request", body);
    expect(result.kind).toBe("provider_env_conflict");
    expect(result.message).toContain("env var conflict");
  });
});
