import { describe, expect, it } from "vitest";
import type { ExecOptions, Sandbox } from "@shipfix/sandbox";
import type { FixService } from "@shipfix/autofix";
import { mergeDeploySummary } from "../src/deploySummary";
import { sandboxRepairWorkspace, smokeStartScript } from "../src/repairWorkspace";

describe("mergeDeploySummary", () => {
  it("lets the retry decide services it attempted and keeps first-pass results otherwise", () => {
    const merged = mergeDeploySummary(
      {
        deployed: ["db-api"],
        failed: [{ id: "web", kind: "build_failed" }, { id: "api", kind: "deploy_failed" }],
        skipped: [{ id: "worker", reason: "env_unresolved" }],
      },
      {
        deployed: ["web", "worker"],
        failed: [{ id: "api", kind: "build_failed" }],
        skipped: [{ id: "db-api", reason: "already_deployed" }],
      },
    );
    expect(merged.deployed.sort()).toEqual(["db-api", "web", "worker"]);
    expect(merged.failed).toEqual([{ id: "api", kind: "build_failed" }]);
    expect(merged.skipped).toEqual([]);
  });
});

function fakeSandbox(results: Record<string, { exitCode: number; stdout?: string; timedOut?: boolean }>) {
  const calls: Array<{ command: string; options: ExecOptions }> = [];
  const files: Record<string, string> = { "a.ts": "x" };
  const sandbox: Sandbox = {
    clone: async () => {},
    exec: async (command, options) => {
      calls.push({ command, options });
      const key = Object.keys(results).find((k) => command.startsWith(k));
      const r = key ? results[key]! : { exitCode: 0 };
      return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: "", timedOut: r.timedOut ?? false };
    },
    readFile: async (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p]!;
    },
    writeFile: async (p, c) => void (files[p] = c),
    list: async () => Object.keys(files),
    allowResolvedAddresses: async () => 0,
    dispose: async () => {},
  };
  return { sandbox, calls, files };
}

const api: FixService = { id: "api", type: "node_api", provider: "render", rootDir: "server", install: "npm install", build: "npm run build", start: "node dist/index.js" };

describe("sandboxRepairWorkspace", () => {
  it("installs then builds in the service root with non-secret env", async () => {
    const { sandbox, calls } = fakeSandbox({});
    const ws = sandboxRepairWorkspace(sandbox, { smokeStart: false, posix: true });
    expect(await ws.verify(api, { NODE_OPTIONS: "--max-old-space-size=6144" })).toEqual({ ok: true, log: "Install and build passed in the sandbox." });
    expect(calls.map((c) => c.command)).toEqual(["npm install", "npm run build"]);
    expect(calls[0]!.options).toMatchObject({ cwd: "server", env: { CI: "1", NODE_OPTIONS: "--max-old-space-size=6144" } });
  });

  it("stops at the first failing step and returns its log", async () => {
    const { sandbox, calls } = fakeSandbox({ "npm install": { exitCode: 1, stdout: "npm ERR! ERESOLVE" } });
    const ws = sandboxRepairWorkspace(sandbox, { smokeStart: false, posix: true });
    const r = await ws.verify(api, {});
    expect(r.ok).toBe(false);
    expect(r.log).toContain("npm ERR! ERESOLVE");
    expect(calls).toHaveLength(1);
  });

  it("smoke-starts web backends on POSIX sandboxes only", async () => {
    const posix = fakeSandbox({});
    await sandboxRepairWorkspace(posix.sandbox, { smokeStart: true, posix: true }).verify(api, {});
    expect(posix.calls[2]!.command).toContain("(node dist/index.js) > /tmp/shipfix-start.log");
    expect(posix.calls[2]!.options.env).toMatchObject({ PORT: "18080" });

    const windows = fakeSandbox({});
    await sandboxRepairWorkspace(windows.sandbox, { smokeStart: true, posix: false }).verify(api, {});
    expect(windows.calls).toHaveLength(2);
  });

  it("reports timeouts and treats unreadable files as missing", async () => {
    const { sandbox } = fakeSandbox({ "npm run build": { exitCode: -1, timedOut: true } });
    const ws = sandboxRepairWorkspace(sandbox, { smokeStart: false, posix: true });
    expect((await ws.verify(api, {})).log).toContain("timed out");
    expect(await ws.readFile("missing.ts")).toBeNull();
  });

  it("builds a smoke script that waits for the port", () => {
    const s = smokeStartScript("npm start", 4321);
    expect(s).toContain("(npm start) > /tmp/shipfix-start.log 2>&1 &");
    expect(s).toContain("http://127.0.0.1:4321/");
    expect(s.trim().endsWith("exit 1")).toBe(true);
  });
});
