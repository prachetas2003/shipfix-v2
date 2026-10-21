import type { Fix, FixContext } from "../types";
import { CODE_FILE_RE, IGNORED_DIR_RE, isUnder } from "../util";

const TEST_FILE_RE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\//;
const QUOTED_ORIGIN = /(['"])https?:\/\/(?:localhost|127\.0\.0\.1):\d+\1/g;

function lineOf(content: string, offset: number): string {
  const start = content.lastIndexOf("\n", offset) + 1;
  const end = content.indexOf("\n", offset);
  return content.slice(start, end === -1 ? content.length : end);
}

/** Swap hardcoded loopback CORS origins for the frontend URL the host injects. */
export function rewriteCorsOrigins(content: string, expr: string): string | null {
  if (!/cors|Access-Control-Allow-Origin|allow_origins|CORSMiddleware/i.test(content)) return null;
  let changed = false;
  const out = content.replace(QUOTED_ORIGIN, (whole, _q: string, offset: number) => {
    const line = lineOf(content, offset);
    if (!/origin|cors|allow/i.test(line)) return whole;
    changed = true;
    return expr;
  });
  return changed ? out : null;
}

/** A CORS allow-list of localhost rejects the deployed frontend. */
export async function fixCorsOrigin(ctx: FixContext): Promise<Fix | null> {
  if (ctx.service.type !== "node_api" && ctx.service.type !== "python_api") return null;
  const expr = ctx.service.type === "python_api" ? `os.environ["FRONTEND_URL"]` : "process.env.FRONTEND_URL";
  const files: Fix["files"] = [];
  for (const file of await ctx.files.listFiles()) {
    const code = CODE_FILE_RE.test(file) || file.endsWith(".py");
    if (!code || IGNORED_DIR_RE.test(file) || TEST_FILE_RE.test(file)) continue;
    if (!isUnder(file, ctx.service.rootDir)) continue;
    const before = await ctx.files.readFile(file);
    if (!before) continue;
    const rewritten = rewriteCorsOrigins(before, expr);
    if (!rewritten) continue;
    const after = file.endsWith(".py") && !/^import os\b|^from os\b/m.test(rewritten) ? `import os\n${rewritten}` : rewritten;
    if (after !== before) files.push({ path: file, before, after });
  }
  if (!files.length) return null;
  return {
    id: "cors-origin",
    title: "Allow the deployed frontend through CORS",
    explanation:
      "The API only allowed a localhost origin, so the browser would block the deployed frontend. It now reads FRONTEND_URL, which ShipFix sets to the live frontend address.",
    files,
    plan: [],
  };
}
