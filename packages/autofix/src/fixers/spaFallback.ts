import type { Fix, FixContext } from "../types";
import { CODE_FILE_RE, IGNORED_DIR_RE, isUnder, joinRoot } from "../util";

const ROUTER_RE = /react-router|wouter|vue-router|@tanstack\/react-router|svelte-routing|createBrowserRouter|BrowserRouter|createRouter/;

/**
 * A static host serves files only. A client-side route such as /dashboard 404s
 * on refresh unless unknown paths fall back to index.html. Paths with a file
 * extension (assets) are left alone.
 */
export async function fixSpaFallback(ctx: FixContext): Promise<Fix | null> {
  if (ctx.service.type !== "frontend_static") return null;
  const vercelPath = joinRoot(ctx.service.rootDir, "vercel.json");
  if (await ctx.files.readFile(vercelPath)) return null;

  const listed = await ctx.files.listFiles();
  const pkg = await ctx.files.readFile(joinRoot(ctx.service.rootDir, "package.json"));
  let routed = pkg != null && ROUTER_RE.test(pkg);
  if (!routed) {
    for (const file of listed) {
      if (!CODE_FILE_RE.test(file) || IGNORED_DIR_RE.test(file) || !isUnder(file, ctx.service.rootDir)) continue;
      const text = await ctx.files.readFile(file);
      if (text && ROUTER_RE.test(text)) {
        routed = true;
        break;
      }
    }
  }
  if (!routed) return null;

  const after = `${JSON.stringify({ rewrites: [{ source: "/((?!.*\\.).*)", destination: "/index.html" }] }, null, 2)}\n`;
  return {
    id: "spa-fallback",
    title: "Serve the app for client-side routes",
    explanation:
      "Refreshing a page like /dashboard asks the host for a file that doesn't exist, so the static host returns 404. Requests without a file extension now serve index.html and the app's router takes over. Existing asset files are unchanged.",
    files: [{ path: vercelPath, before: null, after }],
    plan: [],
  };
}
