import { describe, it, expect } from "vitest";
import { analyzeRepo, repoSourceFromSandbox, type SandboxLike } from "../src/index";

/** A fake in-memory sandbox to prove the analyzer reads only via list/readFile. */
function fakeSandbox(files: Record<string, string>): SandboxLike {
  return {
    async list() {
      return Object.keys(files).sort();
    },
    async readFile(p) {
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    },
  };
}

describe("repoSourceFromSandbox", () => {
  it("returns null (not throw) for missing files", async () => {
    const source = repoSourceFromSandbox(fakeSandbox({ "a.txt": "hi" }));
    expect(await source.readFile("a.txt")).toBe("hi");
    expect(await source.readFile("missing.txt")).toBeNull();
  });

  it("drives a full analyze over a sandbox-backed source", async () => {
    const sandbox = fakeSandbox({
      "package.json": JSON.stringify({
        name: "svc",
        dependencies: { express: "^4.21.0" },
        scripts: { start: "node src/index.js" },
      }),
      "package-lock.json": "{}",
      "src/index.js": "const p = process.env.PORT;\nfetch('http://localhost:9000');",
    });

    const ctx = await analyzeRepo(repoSourceFromSandbox(sandbox), {
      repoFullName: "fake/svc",
      commitSha: "a".repeat(40),
    });

    expect(ctx.services).toHaveLength(1);
    expect(ctx.services[0].framework).toBe("express");
    expect(ctx.services[0].packageManager).toBe("npm");
    expect(ctx.envRefs.map((e) => e.name)).toContain("PORT");
    expect(ctx.hardcodedUrls.some((u) => u.value.includes("localhost:9000"))).toBe(true);
  });
});
