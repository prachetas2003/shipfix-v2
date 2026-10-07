import { describe, expect, it } from "vitest";
import { diagnoseLogs, scrubLogText, tailLines } from "../src/logDiagnosis";

const cases: Array<[string, string, string | null]> = [
  [
    "npm ci lockfile drift",
    "npm ERR! code EUSAGE\nnpm ERR! `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.",
    "lockfile_mismatch",
  ],
  ["pnpm frozen lockfile", " ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date", "lockfile_mismatch"],
  ["peer deps", "npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree", "dependency_conflict"],
  ["missing script", 'npm ERR! Missing script: "build"', "missing_script"],
  ["vite missing package", '[vite]: Rollup failed to resolve import "framer-motion" from "src/App.tsx".', "missing_module"],
  ["node missing package", "Error: Cannot find module 'express'\nRequire stack:\n- /opt/render/project/src/server.js", "missing_module"],
  ["case-sensitive import", "Module not found: Error: Can't resolve './components/Navbar' in '/vercel/path0/src'", "import_path_case"],
  ["typescript", "src/app/page.tsx:12:7 - error TS2322: Type 'string' is not assignable to type 'number'.", "typescript_error"],
  ["next type error", "Type error: Property 'user' does not exist on type '{}'.", "typescript_error"],
  ["heap", "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", "out_of_memory"],
  ["render port", "==> No open ports detected, continuing to scan...\n==> Port scan timeout reached, no open ports detected.", "no_open_port"],
  ["prisma env", "Error: Environment variable not found: DATABASE_URL.", "missing_env"],
  ["python env", "KeyError: 'OPENAI_API_KEY'", "missing_env"],
  ["db localhost", "Error: connect ECONNREFUSED 127.0.0.1:5432", "db_unreachable"],
  ["api localhost", "TypeError: fetch failed\n  cause: Error: connect ECONNREFUSED 127.0.0.1:3001", "localhost_url"],
  ["prisma generate", "Error: @prisma/client did not initialize yet. Please run \"prisma generate\"", "prisma_client"],
  ["pip", "ERROR: Could not find a version that satisfies the requirement torch==9.9.9", "python_dependency"],
  ["python import", "ModuleNotFoundError: No module named 'app'", "python_import"],
  ["tool missing", "sh: 1: vite: not found", "command_not_found"],
  ["node engine", 'error next@15.0.0: The engine "node" is incompatible with this module. Expected version ">=18.18.0". Got "16.20.2"', "node_version"],
];

describe("diagnoseLogs", () => {
  it.each(cases)("%s", (_name, log, kind) => {
    expect(diagnoseLogs(log).kind).toBe(kind);
  });

  it("extracts the subject", () => {
    expect(diagnoseLogs("Error: Cannot find module 'express'").subject).toBe("express");
    expect(diagnoseLogs('npm ERR! Missing script: "start:prod"').subject).toBe("start:prod");
    expect(diagnoseLogs("KeyError: 'STRIPE_SECRET_KEY'")).toMatchObject({ subject: "STRIPE_SECRET_KEY", fixOwner: "user" });
  });

  it("prefers the specific cause over the generic symptom", () => {
    const log = [
      "> next build",
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      "npm ERR! code ELIFECYCLE",
      "Error: Command \"npm run build\" exited with 1",
    ].join("\n");
    expect(diagnoseLogs(log).kind).toBe("out_of_memory");
  });

  it("falls back to unknown with the last error lines as evidence", () => {
    const d = diagnoseLogs("Installing...\nsomething odd failed here\nDone");
    expect(d.kind).toBe("unknown");
    expect(d.evidence).toEqual(["something odd failed here"]);
  });
});

describe("scrubLogText", () => {
  it("removes secret values, longest first, and ignores short values", () => {
    const out = scrubLogText("url=postgres://u:supersecretpw@host/db token=abc", [
      "postgres://u:supersecretpw@host/db",
      "supersecretpw",
      "abc",
    ]);
    expect(out).toBe("url=[redacted] token=abc");
  });
});

describe("tailLines", () => {
  it("keeps the newest lines within the character budget", () => {
    expect(tailLines(["a", "b", "c"], 2)).toBe("b\nc");
    expect(tailLines(["x".repeat(50)], 10, 20)).toHaveLength(20);
  });
});
