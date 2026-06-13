import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleWorkflowCode } from "@temporalio/worker";

/**
 * Workflow sandbox safety net.
 *
 * Temporal workflows run in an isolated, deterministic v8 context: they cannot
 * use Node builtins (node:crypto, fs, net) or anything that transitively
 * imports them (secrets vault, DB clients, LLM runtime, provider adapters).
 * A single careless import in workflows.ts or anything it reaches (e.g.
 * errorMessages.ts) makes the worker crash AT STARTUP with an
 * UnhandledSchemeError — and every run then sits "queued" forever.
 *
 * This test bundles the workflow code exactly like the worker does, so any
 * such regression fails CI instead of taking down the worker.
 */

const workflowsPath = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));

// Bundled module paths that must never appear in the workflow sandbox.
const FORBIDDEN_MODULE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /^node:/, why: "Node builtin (workflows are sandboxed)" },
  { re: /secrets[\\/]src[\\/]/, why: "@shipfix/secrets pulls in node:crypto" },
  { re: /llm[\\/]src[\\/](?!errors\.ts)/, why: "LLM runtime client code (only llm/src/errors.ts is pure)" },
  { re: /[\\/]db[\\/]src[\\/]|drizzle-orm|node_modules[\\/].*[\\/]pg[\\/]/, why: "database client" },
  { re: /adapters[\\/](core|render|vercel)[\\/]src[\\/]/, why: "provider adapter (network runtime)" },
  { re: /observability[\\/]src[\\/]/, why: "observability sink (DB runtime)" },
];

/** Extract the resolved module paths webpack embedded in the dev bundle. */
function bundledModulePaths(code: string): string[] {
  const paths = new Set<string>();
  for (const m of code.matchAll(/\n\/\*\*\*\/ "([^"]+)"/g)) paths.add(m[1]);
  return [...paths];
}

describe("workflow bundle is sandbox-safe", () => {
  it("bundles without Node-only modules (worker can start)", async () => {
    // bundleWorkflowCode throws UnhandledSchemeError if any workflow import
    // reaches a Node builtin — exactly the crash that takes the worker down.
    const { code } = await bundleWorkflowCode({
      workflowsPath,
      logger: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    });

    const modules = bundledModulePaths(code);
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.some((p) => p.includes("workflows.ts"))).toBe(true);

    const offenders = modules.flatMap((path) => {
      const hit = FORBIDDEN_MODULE_PATTERNS.find(({ re }) => re.test(path));
      return hit ? [`${path} — ${hit.why}`] : [];
    });
    expect(offenders, "forbidden modules bundled into the workflow sandbox").toEqual([]);
  }, 120_000);
});
