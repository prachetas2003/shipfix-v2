import { describe, it, expect } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import {
  createGithubAppJwt,
  verifyGithubWebhookSignature,
  shouldAutoDeployPush,
  resolveGithubBranchSha,
  resolveCloneToken,
  resolveGithubDefaultBranch,
  listGithubUserInstallations,
  pushCommitToBranch,
  resolveRepoWriteToken,
  openOrUpdatePullRequest,
  listInstallationRepositories,
} from "../src/index";

describe("pushCommitToBranch", () => {
  function fakeGithub(refStatus: number) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url: url.replace("https://api.github.com", ""), body });
      const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });
      if (method === "GET") return reply(200, { tree: { sha: "basetree" } });
      if (url.endsWith("/git/trees")) return reply(201, { sha: "newtree" });
      if (url.endsWith("/git/commits")) return reply(201, { sha: "newcommit" });
      if (method === "POST") return reply(refStatus, {});
      return reply(200, {});
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("commits on top of the base and creates the branch", async () => {
    const gh = fakeGithub(201);
    const out = await pushCommitToBranch({
      token: "t",
      repoFullName: "o/r",
      baseSha: "abc1234",
      branch: "shipfix/fix-1",
      message: "Fix build",
      changes: [{ path: "a.ts", content: "x" }, { path: "old.ts", content: null }],
      fetchImpl: gh.fetchImpl,
    });
    expect(out).toEqual({ ok: true, sha: "newcommit", url: "https://github.com/o/r/tree/shipfix%2Ffix-1" });
    expect(gh.calls[1]!.body).toEqual({
      base_tree: "basetree",
      tree: [
        { path: "a.ts", mode: "100644", type: "blob", content: "x" },
        { path: "old.ts", mode: "100644", type: "blob", sha: null },
      ],
    });
    expect(gh.calls[2]!.body).toEqual({ message: "Fix build", tree: "newtree", parents: ["abc1234"] });
    expect(gh.calls[3]).toEqual({ method: "POST", url: "/repos/o/r/git/refs", body: { ref: "refs/heads/shipfix/fix-1", sha: "newcommit" } });
  });

  it("force-moves an existing ShipFix branch", async () => {
    const gh = fakeGithub(422);
    const out = await pushCommitToBranch({ token: "t", repoFullName: "o/r", baseSha: "abc1234", branch: "shipfix/fix-1", message: "m", changes: [], fetchImpl: gh.fetchImpl });
    expect(out.ok).toBe(true);
    expect(gh.calls[4]).toEqual({ method: "PATCH", url: "/repos/o/r/git/refs/heads/shipfix/fix-1", body: { sha: "newcommit", force: true } });
  });
});

describe("openOrUpdatePullRequest", () => {
  function fakePulls(existing: Array<{ number: number; html_url: string }>) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: url.replace("https://api.github.com", ""), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET") return new Response(JSON.stringify(existing), { status: 200 });
      if (method === "PATCH") return new Response(JSON.stringify({ html_url: existing[0]!.html_url }), { status: 200 });
      return new Response(JSON.stringify({ number: 7, html_url: "https://github.com/o/r/pull/7" }), { status: 201 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  const base = { token: "t", repoFullName: "o/r", head: "shipfix/fix-1", base: "main", title: "T", body: "B" };

  it("opens a new pull request", async () => {
    const gh = fakePulls([]);
    expect(await openOrUpdatePullRequest({ ...base, fetchImpl: gh.fetchImpl })).toEqual({ ok: true, number: 7, url: "https://github.com/o/r/pull/7", created: true });
    expect(gh.calls[0]!.url).toBe("/repos/o/r/pulls?state=open&head=o%3Ashipfix%2Ffix-1&per_page=1");
    expect(gh.calls[1]).toMatchObject({ method: "POST", body: { head: "shipfix/fix-1", base: "main", title: "T", body: "B" } });
  });

  it("updates the open pull request for the branch", async () => {
    const gh = fakePulls([{ number: 3, html_url: "https://github.com/o/r/pull/3" }]);
    expect(await openOrUpdatePullRequest({ ...base, fetchImpl: gh.fetchImpl })).toEqual({ ok: true, number: 3, url: "https://github.com/o/r/pull/3", created: false });
    expect(gh.calls[1]).toMatchObject({ method: "PATCH", url: "/repos/o/r/pulls/3", body: { title: "T", body: "B" } });
  });
});

describe("resolveRepoWriteToken", () => {
  it("is null without an app config or an owned installation", async () => {
    expect(await resolveRepoWriteToken({ repoFullName: "o/r", allowedInstallationIds: ["1"], config: null })).toBeNull();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(await resolveRepoWriteToken({ repoFullName: "o/r", allowedInstallationIds: [], config: { appId: "1", privateKey: pem } })).toBeNull();
  });

  it("requests contents:write scoped to the repo", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let sent: unknown;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ token: "ghs_x" }), { status: 201 });
    }) as unknown as typeof fetch;
    const token = await resolveRepoWriteToken({ repoFullName: "o/r", installationId: "7", allowedInstallationIds: ["7"], config: { appId: "1", privateKey: pem }, fetchImpl });
    expect(token).toBe("ghs_x");
    expect(sent).toEqual({ repositories: ["r"], permissions: { contents: "write" } });
  });
});

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

describe("resolveCloneToken tenant scoping", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = { appId: "1", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };

  function fakeGithub(installationForRepo: number) {
    const tokenRequests: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/installation")) {
        return new Response(JSON.stringify({ id: installationForRepo }), { status: 200 });
      }
      const m = u.match(/installations\/(\d+)\/access_tokens/);
      if (m) {
        tokenRequests.push(m[1]!);
        return new Response(JSON.stringify({ token: `ghs_${m[1]}` }), { status: 201 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    return { fetchImpl, tokenRequests };
  }

  it("refuses an installation the requesting user has not claimed", async () => {
    const gh = fakeGithub(42);
    const token = await resolveCloneToken({
      repoFullName: "victim/private",
      allowedInstallationIds: ["7"],
      config,
      fetchImpl: gh.fetchImpl,
    });
    expect(token).toBe("");
    expect(gh.tokenRequests).toEqual([]);
  });

  it("ignores a stale project installation id that is not owned", async () => {
    const gh = fakeGithub(42);
    const token = await resolveCloneToken({
      repoFullName: "victim/private",
      installationId: "42",
      allowedInstallationIds: [],
      config,
      fetchImpl: gh.fetchImpl,
    });
    expect(token).toBe("");
  });

  it("mints a repo-scoped token for an owned installation", async () => {
    const gh = fakeGithub(42);
    const token = await resolveCloneToken({
      repoFullName: "me/private",
      allowedInstallationIds: ["42"],
      config,
      fetchImpl: gh.fetchImpl,
    });
    expect(token).toBe("ghs_42");
  });
});

describe("resolveGithubDefaultBranch", () => {
  it("returns the repo's default branch", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ default_branch: "master" }), { status: 200 })) as typeof fetch;
    expect(await resolveGithubDefaultBranch("acme/app", { fetchImpl })).toEqual({ branch: "master" });
  });

  it("reports missing repos", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    const r = await resolveGithubDefaultBranch("acme/nope", { fetchImpl });
    expect("error" in r && r.error).toBe("repo_not_found");
  });
});

describe("listGithubUserInstallations", () => {
  it("maps installations the user can access", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ installations: [{ id: 5, account: { login: "acme", type: "Organization" } }] }),
        { status: 200 },
      )) as typeof fetch;
    expect(await listGithubUserInstallations("ghu_x", { fetchImpl })).toEqual([
      { installationId: "5", accountLogin: "acme", accountType: "Organization" },
    ]);
  });
});

describe("listInstallationRepositories", () => {
  it("returns repo names without echoing the token", async () => {
    let auth = "";
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>).Authorization;
      return new Response(
        JSON.stringify({
          repositories: [
            { full_name: "acme/app", private: true, default_branch: "main" },
            { private: false },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const repos = await listInstallationRepositories("ghs_secret", { fetchImpl });
    expect(repos).toEqual([{ fullName: "acme/app", private: true, defaultBranch: "main" }]);
    expect(auth).toBe("Bearer ghs_secret");
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
