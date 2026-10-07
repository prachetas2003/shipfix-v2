import { describe, expect, it, vi } from "vitest";
import type { LogDiagnosis } from "@shipfix/adapter-core";
import type { DeploymentPlan } from "@shipfix/contracts";
import {
  applyPlanEdits,
  bindToPort,
  fixForDiagnosis,
  mergeFileEdits,
  packageNameOf,
  preflightFixes,
  requiredNodeMajor,
  unfrozenInstall,
  type FixContext,
  type FixService,
  type RepoFiles,
} from "../src/index";

function repo(files: Record<string, string>): RepoFiles {
  return {
    listFiles: async () => Object.keys(files),
    readFile: async (p) => files[p] ?? null,
  };
}

const api: FixService = { id: "api", type: "node_api", provider: "render", rootDir: "", install: "npm ci", build: null, start: "npm start" };
const web: FixService = { id: "web", type: "frontend_static", provider: "vercel", rootDir: "", install: "npm install", build: "npm run build", start: null };

function ctx(files: Record<string, string>, service: FixService = api, extra: Partial<FixContext> = {}): FixContext {
  return { files: repo(files), service, ...extra };
}

function diagnosis(kind: LogDiagnosis["kind"], extra: Partial<LogDiagnosis> = {}): LogDiagnosis {
  return { kind, phase: "build", title: "", explanation: "", fixOwner: "deterministic", evidence: [], ...extra };
}

const pkg = (obj: object) => `${JSON.stringify(obj, null, 2)}\n`;

describe("import-path-case", () => {
  it("rewrites imports whose casing only matches on Mac and Windows", async () => {
    const files = {
      "src/App.tsx": `import Header from "./components/header";\nimport { api } from '../lib/Api';\nconst x = require("./utils/Format.js");\n`,
      "src/components/Header.tsx": "",
      "lib/api.ts": "",
      "src/utils/format.js": "",
    };
    const [fix] = await preflightFixes(ctx(files, web));
    expect(fix?.id).toBe("import-path-case");
    expect(fix!.files[0]!.after).toBe(
      `import Header from "./components/Header";\nimport { api } from '../lib/api';\nconst x = require("./utils/format.js");\n`,
    );
  });

  it("leaves correct, missing, and ambiguous imports alone", async () => {
    const files = {
      "src/a.ts": `import "./b";\nimport "./missing";\nimport "./dup";\nimport "lodash";\n`,
      "src/b.ts": "",
      "src/Dup.ts": "",
      "src/DUP.ts": "",
    };
    expect(await preflightFixes(ctx(files, web))).toEqual([]);
  });
});

describe("port-binding", () => {
  it("binds a hardcoded listen port and loopback host", () => {
    expect(bindToPort(`app.listen(3000, "localhost", () => {});`)).toBe(
      `app.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => {});`,
    );
  });

  it("rewrites a port constant used by listen", () => {
    const src = `const PORT: number = 8080;\nserver.listen(PORT, '127.0.0.1');\n`;
    expect(bindToPort(src)).toBe(`const PORT: number = Number(process.env.PORT) || 8080;\nserver.listen(PORT, '0.0.0.0');\n`);
  });

  it("handles fastify's object form and adds a host", () => {
    expect(bindToPort(`await app.listen({ port: 4000 });`)).toBe(
      `await app.listen({ port: Number(process.env.PORT) || 4000, host: '0.0.0.0' });`,
    );
  });

  it("skips files that already read PORT", () => {
    expect(bindToPort(`app.listen(process.env.PORT || 3000);`)).toBeNull();
  });

  it("only applies to Node APIs and skips tests", async () => {
    const files = { "server.js": "app.listen(3000);\n", "test/server.test.js": "app.listen(3001);\n" };
    const fixes = await preflightFixes(ctx(files));
    expect(fixes.map((f) => f.id)).toEqual(["port-binding"]);
    expect(fixes[0]!.files.map((f) => f.path)).toEqual(["server.js"]);
    expect(await preflightFixes(ctx(files, web))).toEqual([]);
  });
});

describe("prisma-generate", () => {
  it("adds prisma generate to postinstall, keeping indentation", async () => {
    const before = `${JSON.stringify({ name: "a", scripts: { postinstall: "patch-package" }, dependencies: { "@prisma/client": "5" }, devDependencies: { prisma: "5" } }, null, 4)}\n`;
    const [fix] = await preflightFixes(ctx({ "package.json": before, "prisma/schema.prisma": "" }));
    const after = fix!.files[0]!.after;
    expect(JSON.parse(after).scripts.postinstall).toBe("prisma generate && patch-package");
    expect(after).toMatch(/^\{\n {4}"name"/);
    expect(after.endsWith("}\n")).toBe(true);
  });

  it("passes --schema for a non-default location and respects rootDir", async () => {
    const files = {
      "apps/api/package.json": pkg({ dependencies: { "@prisma/client": "5", prisma: "5" } }),
      "apps/api/db/schema.prisma": "",
    };
    const [fix] = await preflightFixes(ctx(files, { ...api, rootDir: "apps/api" }));
    expect(fix!.files[0]!.path).toBe("apps/api/package.json");
    expect(JSON.parse(fix!.files[0]!.after).scripts.postinstall).toBe("prisma generate --schema db/schema.prisma");
  });

  it("does nothing when the build already generates", async () => {
    const files = { "package.json": pkg({ scripts: { build: "prisma generate && tsc" }, dependencies: { "@prisma/client": "5", prisma: "5" } }), "prisma/schema.prisma": "" };
    expect(await preflightFixes(ctx(files))).toEqual([]);
  });
});

describe("preflightFixes", () => {
  it("composes fixes that touch different files", async () => {
    const files = {
      "package.json": pkg({ dependencies: { "@prisma/client": "5", prisma: "5" } }),
      "prisma/schema.prisma": "",
      "src/index.js": `import db from "./DB.js";\napp.listen(3000);\n`,
      "src/db.js": "",
    };
    const fixes = await preflightFixes(ctx(files));
    expect(fixes.map((f) => f.id)).toEqual(["import-path-case", "port-binding", "prisma-generate"]);
    const merged = mergeFileEdits(fixes);
    const index = merged.find((e) => e.path === "src/index.js")!;
    expect(index.before).toBe(files["src/index.js"]);
    expect(index.after).toBe(`import db from "./db.js";\napp.listen(Number(process.env.PORT) || 3000);\n`);
  });
});

describe("fixForDiagnosis", () => {
  it("adds a missing package at the lockfile's version and unfreezes npm ci", async () => {
    const files = {
      "package.json": pkg({ dependencies: { react: "^19.0.0" } }),
      "package-lock.json": JSON.stringify({ packages: { "node_modules/framer-motion": { version: "11.2.0" } } }),
    };
    const fix = await fixForDiagnosis(ctx(files), diagnosis("missing_module", { subject: "framer-motion/dist/es" }));
    expect(JSON.parse(fix!.files[0]!.after).dependencies).toEqual({ "framer-motion": "^11.2.0", react: "^19.0.0" });
    expect(fix!.plan).toEqual([{ serviceId: "api", field: "install", from: "npm ci", to: "npm install" }]);
  });

  it("falls back to the npm registry and puts @types in devDependencies", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: "4.17.21" }))) as unknown as typeof fetch;
    const fix = await fixForDiagnosis(ctx({ "package.json": pkg({}) }, web, { fetchImpl }), diagnosis("missing_module", { subject: "@types/express" }));
    expect(String(vi.mocked(fetchImpl).mock.calls[0]![0])).toBe("https://registry.npmjs.org/@types%2Fexpress/latest");
    expect(JSON.parse(fix!.files[0]!.after).devDependencies).toEqual({ "@types/express": "^4.17.21" });
    expect(fix!.plan).toEqual([]);
  });

  it("skips relative paths, builtins, and packages already declared", async () => {
    const files = { "package.json": pkg({ devDependencies: { zod: "3" } }) };
    for (const subject of ["./utils", "fs", "node:path", "zod", "@/components/x"]) {
      expect(await fixForDiagnosis(ctx(files), diagnosis("missing_module", { subject }))).toBeNull();
    }
  });

  it("pins engines.node from the log", async () => {
    const fix = await fixForDiagnosis(
      ctx({ "package.json": pkg({ name: "a" }) }),
      diagnosis("node_version", { evidence: [`error vite@7.0.0: The engine "node" is incompatible with this module. Expected version "^20.19.0 || >=22.12.0". Got "18.20.4"`] }),
    );
    expect(JSON.parse(fix!.files[0]!.after).engines).toEqual({ node: "22.x" });
  });

  it("adds a start script from main or a common entry file", async () => {
    const fix = await fixForDiagnosis(ctx({ "package.json": pkg({ name: "a" }), "server.js": "" }), diagnosis("missing_script", { subject: "start" }));
    expect(JSON.parse(fix!.files[0]!.after).scripts).toEqual({ start: "node server.js" });
    const none = await fixForDiagnosis(ctx({ "package.json": pkg({ name: "a" }), "src/index.ts": "" }), diagnosis("missing_script", { subject: "start" }));
    expect(none).toBeNull();
  });

  it("adds a vite build script for frontends", async () => {
    const fix = await fixForDiagnosis(ctx({ "package.json": pkg({ devDependencies: { vite: "6" } }) }, web), diagnosis("missing_script", { subject: "build" }));
    expect(JSON.parse(fix!.files[0]!.after).scripts).toEqual({ build: "vite build" });
  });

  it("relaxes frozen installs on lockfile mismatch", async () => {
    const fix = await fixForDiagnosis(ctx({}, { ...api, install: "pnpm install --frozen-lockfile" }), diagnosis("lockfile_mismatch"));
    expect(fix!.plan).toEqual([{ serviceId: "api", field: "install", from: "pnpm install --frozen-lockfile", to: "pnpm install --no-frozen-lockfile" }]);
    expect(await fixForDiagnosis(ctx({}, web), diagnosis("lockfile_mismatch"))).toBeNull();
  });

  it("appends legacy-peer-deps to .npmrc only for npm projects", async () => {
    const fix = await fixForDiagnosis(ctx({ ".npmrc": "fund=false" }, web), diagnosis("dependency_conflict"));
    expect(fix!.files[0]).toEqual({ path: ".npmrc", before: "fund=false", after: "fund=false\nlegacy-peer-deps=true\n" });
    expect(await fixForDiagnosis(ctx({ "pnpm-lock.yaml": "" }, web), diagnosis("dependency_conflict"))).toBeNull();
  });

  it("raises build memory on Vercel only", async () => {
    const fix = await fixForDiagnosis(ctx({}, web), diagnosis("out_of_memory"));
    expect(fix!.plan).toEqual([{ serviceId: "web", env: { name: "NODE_OPTIONS", value: "--max-old-space-size=6144" } }]);
    expect(await fixForDiagnosis(ctx({}), diagnosis("out_of_memory"))).toBeNull();
    expect(await fixForDiagnosis(ctx({}, web), diagnosis("out_of_memory", { phase: "runtime" }))).toBeNull();
  });

  it("leaves LLM and user-owned failures alone", async () => {
    expect(await fixForDiagnosis(ctx({}), diagnosis("typescript_error"))).toBeNull();
    expect(await fixForDiagnosis(ctx({}), diagnosis("missing_env"))).toBeNull();
  });
});

describe("helpers", () => {
  it("extracts package names", () => {
    expect(packageNameOf("@scope/pkg/sub")).toBe("@scope/pkg");
    expect(packageNameOf("lodash/fp")).toBe("lodash");
    expect(packageNameOf("crypto")).toBeNull();
    expect(packageNameOf("~/lib")).toBeNull();
  });

  it("reads the required node major", () => {
    expect(requiredNodeMajor("Node.js version >=20.9.0 is required.")).toBe(20);
    expect(requiredNodeMajor("This package requires Node 24 or higher")).toBe(24);
    expect(requiredNodeMajor("nothing here")).toBeNull();
  });

  it("unfreezes install commands", () => {
    expect(unfrozenInstall("npm ci --include=dev")).toBe("npm install --include=dev");
    expect(unfrozenInstall("yarn install --frozen-lockfile")).toBe("yarn install");
    expect(unfrozenInstall("npm install")).toBeNull();
  });

  it("applies plan edits", () => {
    const plan = { services: [{ id: "web", install: "npm ci", env: [{ name: "NODE_OPTIONS", source: "literal", value: "x" }] }] } as unknown as DeploymentPlan;
    const next = applyPlanEdits(plan, [
      { serviceId: "web", field: "install", from: "npm ci", to: "npm install" },
      { serviceId: "web", env: { name: "NODE_OPTIONS", value: "--max-old-space-size=6144" } },
    ]);
    expect(next.services[0]!.install).toBe("npm install");
    expect(next.services[0]!.env).toEqual([{ name: "NODE_OPTIONS", source: "literal", value: "--max-old-space-size=6144" }]);
    expect(plan.services[0]!.install).toBe("npm ci");
  });
});
