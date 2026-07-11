import { describe, it, expect } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import {
  createGithubAppJwt,
  verifyGithubWebhookSignature,
  shouldAutoDeployPush,
  resolveGithubBranchSha,
} from "../src/index";

describe("createGithubAppJwt", () => {
  it("signs a JWT with the app private key", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = createGithubAppJwt({ appId: "12345", privateKey: pem }, 1_700_000_000);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      iss: string;
    };
    expect(payload.iss).toBe("12345");
  });
});

describe("verifyGithubWebhookSignature", () => {
  it("accepts a valid sha256 signature", () => {
    const body = Buffer.from('{"ok":true}');
    const secret = "whsec_test";
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyGithubWebhookSignature(body, sig, secret)).toBe(true);
    expect(verifyGithubWebhookSignature(body, "sha256=deadbeef", secret)).toBe(false);
  });
});

describe("shouldAutoDeployPush", () => {
  it("accepts default-branch pushes with a real sha", () => {
    const r = shouldAutoDeployPush(
      {
        ref: "refs/heads/main",
        after: "abc1234def",
        repository: { full_name: "acme/app" },
        installation: { id: 99 },
      },
      "main",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repoFullName).toBe("acme/app");
      expect(r.installationId).toBe("99");
    }
  });

  it("rejects other branches and deletes", () => {
    expect(
      shouldAutoDeployPush({ ref: "refs/heads/feat", after: "abc1234", repository: { full_name: "a/b" } }, "main")
        .ok,
    ).toBe(false);
    expect(
      shouldAutoDeployPush(
        { ref: "refs/heads/main", after: "abc1234", deleted: true, repository: { full_name: "a/b" } },
        "main",
      ).ok,
    ).toBe(false);
  });
});

describe("resolveGithubBranchSha", () => {
  it("passes Authorization when a token is provided", async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      return new Response(JSON.stringify({ sha: "a".repeat(40) }), { status: 200 });
    }) as typeof fetch;
    const r = await resolveGithubBranchSha("acme/app", "main", {
      token: "ghs_test",
      fetchImpl,
    });
    expect(r).toEqual({ sha: "a".repeat(40) });
    expect(calls[0]?.auth).toBe("Bearer ghs_test");
  });
});
