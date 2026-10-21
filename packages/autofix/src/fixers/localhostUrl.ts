import type { Fix, FixContext } from "../types";
import { CODE_FILE_RE, IGNORED_DIR_RE, isUnder, joinRoot, parsePackageJson } from "../util";

const TEST_FILE_RE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const CONFIG_FILE_RE = /(^|\/)(vite|next|nuxt|astro|svelte|webpack|rollup|tsup)\.config\.[cm]?[jt]s$/i;
const LOOPBACK = String.raw`https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?`;
const FALLBACK = new RegExp(String.raw`\s*(?:\|\||\?\?)\s*(['"\`])${LOOPBACK}(?:\/[^'"\`\s]*)?\1`, "g");
const QUOTED = new RegExp(String.raw`(['"\`])(${LOOPBACK})(\/[^'"\`\s]*)?\1`, "g");

function skipLoopback(content: string, offset: number, whole: string): boolean {
  const lineStart = content.lastIndexOf("\n", offset) + 1;
  const lineEnd = content.indexOf("\n", offset);
  const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
  return /\.listen\s*\(/.test(line) || /:(?:5432|3306|6379|27017)\b/.test(whole);
}

/** The client env expression this frontend actually inlines at build time. */
export function clientApiEnvExpr(packageJson: string | null): string {
  const pkg = parsePackageJson(packageJson);
  const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
  if ("next" in deps) return "process.env.NEXT_PUBLIC_API_URL";
  if ("react-scripts" in deps) return "process.env.REACT_APP_API_URL";
  return "import.meta.env.VITE_API_URL";
}

/**
 * Replace a quoted loopback API URL with the client env expression.
 * A `|| "http://localhost:…"` fallback is removed: the host injects the live URL,
 * and a leftover localhost literal is what the planner treats as a broken frontend.
 * Server `.listen` calls and database ports are left alone.
 */
export function rewriteLocalhostApiUrls(content: string, envExpr: string): string | null {
  let changed = false;
  const stripped = content.replace(FALLBACK, (whole, _q: string, offset: number) => {
    if (skipLoopback(content, offset, whole)) return whole;
    changed = true;
    return "";
  });
  const out = stripped.replace(QUOTED, (whole, _q: string, _origin: string, path: string | undefined, offset: number) => {
    if (skipLoopback(stripped, offset, whole)) return whole;
    changed = true;
    const suffix = path && path !== "/" ? path : "";
    return suffix ? `\`\${${envExpr}}${suffix}\`` : envExpr;
  });
  return changed ? out : null;
}

/** A frontend that calls localhost keeps calling the developer's machine after deploy. */
export async function fixLocalhostApiUrl(ctx: FixContext): Promise<Fix | null> {
  if (ctx.service.type !== "frontend_static" && ctx.service.type !== "frontend_ssr") return null;
  const pkgPath = joinRoot(ctx.service.rootDir, "package.json");
  const envExpr = clientApiEnvExpr(await ctx.files.readFile(pkgPath));
  const files: Fix["files"] = [];
  for (const file of await ctx.files.listFiles()) {
    if (!CODE_FILE_RE.test(file) || IGNORED_DIR_RE.test(file) || TEST_FILE_RE.test(file) || CONFIG_FILE_RE.test(file)) continue;
    if (!isUnder(file, ctx.service.rootDir)) continue;
    const before = await ctx.files.readFile(file);
    if (!before) continue;
    const after = rewriteLocalhostApiUrls(before, envExpr);
    if (after) files.push({ path: file, before, after });
  }
  if (!files.length) return null;
  const name = envExpr.split(".").pop() ?? "API_URL";
  return {
    id: "localhost-api-url",
    title: "Call the deployed API instead of localhost",
    explanation: `The frontend called a localhost URL, which only exists on the machine that built it. Those calls now read ${name}. ShipFix sets that to the deployed API address when the backend is part of this deploy.`,
    files,
    plan: [],
  };
}
