import { describe, expect, it } from "vitest";
import { diagnoseLogs, type LogDiagnosis } from "@shipfix/adapter-core";
import { createFakeGateway } from "@shipfix/llm/testing";
import {
  applyProposedEdits,
  resolveLogPath,
  runRepairLoop,
  selectContextFiles,
  unifiedDiff,
  type FixService,
  type RepairWorkspace,
} from "../src/index";

const web: FixService = { id: "web", type: "frontend_static", provider: "vercel", rootDir: "", install: "npm ci", build: "npm run build", start: null };

function workspace(
  initial: Record<string, string>,
  build: (files: Record<string, string>, service: FixService, env: Record<string, string>) => string | null,
) {
  const files = { ...initial };
  const builds: Array<{ service: FixService; env: Record<string, string> }> = [];
  const ws: RepairWorkspace = {
    listFiles: async () => Object.keys(files),
    readFile: async (p) => files[p] ?? null,
    writeFile: async (p, c) => void (files[p] = c),
    deleteFile: async (p) => void delete files[p],
    verify: async (service, env) => {
      builds.push({ service, env });
      const err = build(files, service, env);
      return err ? { ok: false, log: err } : { ok: true, log: "build ok" };
    },
  };
  return { ws, files, builds };
}

const TS_ERROR = `src/App.tsx(3,7): error TS2322: Type 'number' is not assignable to type 'string'.`;
const tsDiagnosis = (): LogDiagnosis => diagnoseLogs(TS_ERROR);

describe("applyProposedEdits", () => {
  const repo = { listFiles: async () => ["a.ts", "package-lock.json"], readFile: async (p: string) => (p === "a.ts" ? "x = 1;\nx = 1;\ny = 2;\n" : "{}") };

  it("applies a unique find/replace and creates new files", async () => {
    const r = await applyProposedEdits(repo, [
      { path: "a.ts", find: "y = 2;", replace: "y = 3;" },
      { path: "./src/new.ts", replace: "export {};\n" },
    ]);
    expect(r).toEqual({
      ok: true,
      files: [
        { path: "a.ts", before: "x = 1;\nx = 1;\ny = 2;\n", after: "x = 1;\nx = 1;\ny = 3;\n" },
        { path: "src/new.ts", before: null, after: "export {};\n" },
      ],
    });
  });

  it("rejects ambiguous finds, protected paths, and escapes", async () => {
    expect(await applyProposedEdits(repo, [{ path: "a.ts", find: "x = 1;", replace: "" }])).toMatchObject({ ok: false, error: expect.stringContaining("matched 2 times") });
    expect(await applyProposedEdits(repo, [{ path: "package-lock.json", replace: "{}" }])).toMatchObject({ ok: false });
    expect(await applyProposedEdits(repo, [{ path: ".env.local", replace: "A=1" }])).toMatchObject({ ok: false });
    expect(await applyProposedEdits(repo, [{ path: "../etc/passwd", replace: "" }])).toMatchObject({ ok: false });
  });
});

describe("selectContextFiles", () => {
  it("maps build-machine paths to repo files and adds the manifest", async () => {
    const files = { "apps/web/src/App.tsx": "a", "apps/web/package.json": "{}", "apps/web/tsconfig.json": "{}", ".env": "SECRET=1" };
    const repo = { listFiles: async () => Object.keys(files), readFile: async (p: string) => files[p as keyof typeof files] ?? null };
    const service = { ...web, rootDir: "apps/web" };
    const diag = diagnoseLogs(`/vercel/path0/apps/web/src/App.tsx(3,7): error TS2322: bad`);
    const picked = await selectContextFiles(repo, service, diag, "");
    expect(picked.map((f) => f.path)).toEqual(["apps/web/src/App.tsx", "apps/web/package.json", "apps/web/tsconfig.json"]);
  });

  it("resolves relative, rooted and absolute log paths", () => {
    const files = ["apps/api/src/index.ts", "src/index.ts"];
    expect(resolveLogPath("src/index.ts", files, "apps/api")).toBe("src/index.ts");
    expect(resolveLogPath("/opt/render/project/src/apps/api/src/index.ts", files, "apps/api")).toBe("apps/api/src/index.ts");
    expect(resolveLogPath("node_modules/x/index.ts", files, "")).toBeNull();
  });
});

describe("unifiedDiff", () => {
  it("renders a hunk with context", () => {
    const d = unifiedDiff({ path: "a.ts", before: "1\n2\n3\n4\n5\n6\n7\n8\n", after: "1\n2\n3\n4x\n5\n6\n7\n8\n" });
    expect(d).toBe("--- a/a.ts\n+++ b/a.ts\n@@ -1,7 +1,7 @@\n 1\n 2\n 3\n-4\n+4x\n 5\n 6\n 7\n");
  });
});

describe("runRepairLoop", () => {
  it("uses the rule-based fix first and verifies it with the edited plan", async () => {
    const { ws, builds } = workspace({ "package.json": "{}\n" }, (_f, service) =>
      service.install === "npm ci" ? "npm ERR! `npm ci` can only install packages when your package.json and package-lock.json are in sync" : null,
    );
    const diag = diagnoseLogs("npm ERR! `npm ci` can only install packages when your package.json and package-lock.json are in sync");
    const llm = createFakeGateway("should not be called");
    const out = await runRepairLoop({ workspace: ws, service: web, diagnosis: diag, log: "", llm: llm.gateway });
    expect(out.status).toBe("fixed");
    expect(out.status === "fixed" && out.plan).toEqual([{ serviceId: "web", field: "install", from: "npm ci", to: "npm install" }]);
    expect(builds[0]!.service.install).toBe("npm install");
    expect(llm.calls).toHaveLength(0);
  });

  it("asks the model, applies its edit, and accepts a passing build", async () => {
    const { ws, files } = workspace({ "src/App.tsx": "const a = 1;\n\nconst b: string = 5;\n", "package.json": "{}" }, (f) =>
      f["src/App.tsx"]!.includes(": string = 5") ? TS_ERROR : null,
    );
    const llm = createFakeGateway(JSON.stringify({
      explanation: "b is typed as a string but assigned a number.",
      canFix: true,
      edits: [{ path: "src/App.tsx", find: "const b: string = 5;", replace: "const b: string = \"5\";" }],
    }));
    const out = await runRepairLoop({ workspace: ws, service: web, diagnosis: tsDiagnosis(), log: TS_ERROR, llm: llm.gateway });
    expect(out).toMatchObject({ status: "fixed", fullyVerified: true, explanation: "b is typed as a string but assigned a number." });
    expect(files["src/App.tsx"]).toContain('"5"');
    expect(llm.calls[0]!.user).toContain("### src/App.tsx");
    expect(llm.calls[0]!.user).toContain("### package.json");
  });

  it("reverts a failed attempt, tells the model why, and succeeds on retry", async () => {
    const { ws, files } = workspace({ "src/App.tsx": "const b: string = 5;\n" }, (f) => (f["src/App.tsx"]!.includes("= 5;") ? TS_ERROR : null));
    const llm = createFakeGateway([
      JSON.stringify({ explanation: "try 1", canFix: true, edits: [{ path: "src/Other.ts", replace: "export {};\n" }] }),
      JSON.stringify({ explanation: "try 2", canFix: true, edits: [{ path: "src/App.tsx", find: "= 5;", replace: "= '5';" }] }),
    ]);
    const out = await runRepairLoop({ workspace: ws, service: web, diagnosis: tsDiagnosis(), log: TS_ERROR, llm: llm.gateway });
    expect(out.status).toBe("fixed");
    expect(files["src/Other.ts"]).toBeUndefined();
    expect(out.attempts.map((a) => a.outcome)).toEqual(["failed", "passed"]);
    expect(llm.calls[1]!.user).toContain("Earlier attempts that did not work");
    expect(out.status === "fixed" && out.files.map((f) => f.path)).toEqual(["src/App.tsx"]);
  });

  it("keeps progress across different errors and accepts a stop on missing env", async () => {
    const { ws } = workspace({ "src/App.tsx": "const b: string = 5;\n" }, (f) =>
      f["src/App.tsx"]!.includes("= 5;") ? TS_ERROR : "Error: Missing required environment variable: STRIPE_SECRET_KEY",
    );
    const llm = createFakeGateway(JSON.stringify({ explanation: "fix", canFix: true, edits: [{ path: "src/App.tsx", find: "= 5;", replace: "= '5';" }] }));
    const out = await runRepairLoop({ workspace: ws, service: web, diagnosis: tsDiagnosis(), log: TS_ERROR, llm: llm.gateway });
    expect(out).toMatchObject({ status: "fixed", fullyVerified: false });
  });

  it("returns needs_user when the model says it can't fix", async () => {
    const { ws } = workspace({ "src/App.tsx": "x" }, () => TS_ERROR);
    const llm = createFakeGateway(JSON.stringify({ explanation: "needs a key", canFix: false, needsFromUser: "Add your Stripe key.", edits: [] }));
    const out = await runRepairLoop({ workspace: ws, service: web, diagnosis: tsDiagnosis(), log: TS_ERROR, llm: llm.gateway });
    expect(out).toMatchObject({ status: "needs_user", message: "Add your Stripe key." });
  });

  it("gives up after the attempt cap and on rejected edits", async () => {
    const { ws, builds } = workspace({ "src/App.tsx": "x" }, () => TS_ERROR);
    const llm = createFakeGateway(JSON.stringify({ explanation: "bad", canFix: true, edits: [{ path: "src/App.tsx", find: "nope", replace: "y" }] }));
    const out = await runRepairLoop({ workspace: ws, service: web, diagnosis: tsDiagnosis(), log: TS_ERROR, llm: llm.gateway, maxAttempts: 2 });
    expect(out.status).toBe("gave_up");
    expect(out.attempts.map((a) => a.outcome)).toEqual(["rejected", "rejected"]);
    expect(builds).toHaveLength(0);
  });

  it("gives up without a model when no rule applies", async () => {
    const { ws } = workspace({}, () => TS_ERROR);
    const out = await runRepairLoop({ workspace: ws, service: web, diagnosis: tsDiagnosis(), log: TS_ERROR, llm: null });
    expect(out).toMatchObject({ status: "gave_up", attempts: [] });
  });

  it("gives up cleanly when the model is unavailable", async () => {
    const { ws } = workspace({}, () => TS_ERROR);
    const llm = { model: "x", complete: async () => { throw new Error("LLM call limit reached"); } };
    const out = await runRepairLoop({ workspace: ws, service: web, diagnosis: tsDiagnosis(), log: TS_ERROR, llm });
    expect(out).toMatchObject({ status: "gave_up", reason: expect.stringContaining("LLM call limit reached") });
  });
});
