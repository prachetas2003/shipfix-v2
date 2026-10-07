import type { Fix, FixContext } from "../types";
import { CODE_FILE_RE, dirOf, IGNORED_DIR_RE, isUnder, normalizePath } from "../util";

const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]+)\2/g;
const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".vue", ".svelte"];

function candidates(base: string): string[] {
  return [base, ...RESOLVE_EXTS.map((e) => base + e), ...RESOLVE_EXTS.map((e) => `${base}/index${e}`)];
}

/**
 * Relative imports that only resolve on a case-insensitive file system (macOS,
 * Windows) fail on Linux build machines. Rewrite each to the real casing.
 */
export async function fixImportCase(ctx: FixContext): Promise<Fix | null> {
  const all = await ctx.files.listFiles();
  const exact = new Set(all);
  const lower = new Map<string, string[]>();
  for (const f of all) {
    const key = f.toLowerCase();
    lower.set(key, [...(lower.get(key) ?? []), f]);
  }

  const files: Fix["files"] = [];
  const renames: string[] = [];
  for (const file of all) {
    if (!CODE_FILE_RE.test(file) || IGNORED_DIR_RE.test(file) || !isUnder(file, ctx.service.rootDir)) continue;
    const before = await ctx.files.readFile(file);
    if (!before) continue;
    const after = before.replace(SPECIFIER_RE, (whole, lead: string, quote: string, spec: string) => {
      const named = spec.replace(/^(?:\.\.?\/)+/, "");
      if (!named || /(^|\/)\.\.?(\/|$)/.test(named)) return whole;
      const base = normalizePath(`${dirOf(file)}/${spec}`);
      if (base === null) return whole;
      const cands = candidates(base);
      if (cands.some((c) => exact.has(c))) return whole;
      for (const c of cands) {
        const matches = lower.get(c.toLowerCase());
        if (matches?.length !== 1) continue;
        const actualBase = matches[0]!.slice(0, base.length);
        if (actualBase.toLowerCase() !== base.toLowerCase()) continue;
        const fixed = spec.slice(0, spec.length - named.length) + actualBase.slice(actualBase.length - named.length);
        if (fixed === spec) return whole;
        renames.push(`${file}: "${spec}" → "${fixed}"`);
        return `${lead}${quote}${fixed}${quote}`;
      }
      return whole;
    });
    if (after !== before) files.push({ path: file, before, after });
  }
  if (!files.length) return null;
  return {
    id: "import-path-case",
    title: "Fix import paths that only work on Mac and Windows",
    explanation: `Linux build servers treat upper and lower case in file names as different, so these imports point at files that don't exist there:\n${renames.map((r) => `- ${r}`).join("\n")}`,
    files,
    plan: [],
  };
}
