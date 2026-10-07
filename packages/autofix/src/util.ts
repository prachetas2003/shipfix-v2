import type { FileEdit, RepoFiles } from "./types";

export function joinRoot(rootDir: string, rel: string): string {
  return rootDir ? `${rootDir}/${rel}` : rel;
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function isUnder(path: string, rootDir: string): boolean {
  return rootDir === "" || path.startsWith(`${rootDir}/`);
}

/** Resolve `.` and `..` segments; null if the path escapes the repo root. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

export const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/;
export const IGNORED_DIR_RE = /(^|\/)(node_modules|dist|build|\.next|\.output|coverage|\.git|vendor)\//;

export interface PackageJson {
  name?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  [key: string]: unknown;
}

export function parsePackageJson(text: string | null): PackageJson | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as PackageJson) : null;
  } catch {
    return null;
  }
}

/** Re-serialize with the file's own indentation and trailing newline. */
export function stringifyLike(original: string, value: unknown): string {
  const indent = /^\{\r?\n([ \t]+)"/.exec(original)?.[1] ?? "  ";
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const body = JSON.stringify(value, null, indent).replace(/\n/g, eol);
  return /\r?\n$/.test(original) ? body + eol : body;
}

export function allDeps(pkg: PackageJson): Record<string, string> {
  return { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
}

/**
 * Repo view with pending edits applied, so fixes that touch the same file
 * (two package.json changes) compose instead of overwriting each other.
 */
export class Overlay implements RepoFiles {
  private readonly edits = new Map<string, FileEdit>();

  constructor(private readonly base: RepoFiles) {}

  async listFiles(): Promise<string[]> {
    const files = await this.base.listFiles();
    const added = [...this.edits.keys()].filter((p) => !files.includes(p));
    return [...files, ...added];
  }

  async readFile(path: string): Promise<string | null> {
    const edit = this.edits.get(path);
    return edit ? edit.after : this.base.readFile(path);
  }

  record(files: FileEdit[]): void {
    for (const f of files) {
      const prior = this.edits.get(f.path);
      this.edits.set(f.path, { path: f.path, before: prior ? prior.before : f.before, after: f.after });
    }
  }
}
