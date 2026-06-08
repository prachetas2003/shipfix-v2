/** Shared path + parsing helpers. All paths are POSIX, repo-root-relative. */

/** Directory of a repo-relative file path. "" for a root-level file. */
export function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

/** Base file name of a path. */
export function baseOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

/** Join a service root dir with a relative child path (root "" -> child). */
export function joinRoot(rootDir: string, child: string): string {
  return rootDir === "" ? child : `${rootDir}/${child}`;
}

/** True when `file` lives inside (or equals the root of) `rootDir`. */
export function isUnder(file: string, rootDir: string): boolean {
  if (rootDir === "") return true;
  return file === rootDir || file.startsWith(`${rootDir}/`);
}

/**
 * Given a set of service root dirs, pick the most specific one that contains
 * `file` (longest matching prefix). Returns "" when nothing else matches.
 */
export function nearestRoot(file: string, roots: string[]): string {
  let best = "";
  let bestLen = -1;
  for (const root of roots) {
    if (!isUnder(file, root)) continue;
    if (root.length > bestLen) {
      best = root;
      bestLen = root.length;
    }
  }
  return best;
}

export interface PackageJson {
  name?: string;
  main?: string;
  type?: string;
  packageManager?: string;
  workspaces?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export function safeParseJson<T>(text: string | null): T | null {
  if (text == null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Merged dependency map (deps + devDeps + peerDeps). */
export function allDeps(pkg: PackageJson): Record<string, string> {
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
}

/** Source-file extensions the analyzer scans for env refs / URL smells. */
export const CODE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

export function isCodeFile(relPath: string): boolean {
  return CODE_EXTENSIONS.some((ext) => relPath.endsWith(ext));
}

/** Cap per-file scan size so a giant generated file can't dominate analysis. */
export const MAX_SCAN_BYTES = 256 * 1024;
