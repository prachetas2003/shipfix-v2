import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * RepoSource — the read-only surface the analyzer needs over a repository.
 *
 * The analyzer is intentionally decoupled from HOW files are obtained. In
 * production an adapter wraps the @shipfix/sandbox (untrusted clone); in tests
 * we read a fixture directory from disk. Either way the analyzer only ever
 * READS — it never executes repo code.
 *
 * Paths are always repo-root-relative and POSIX-style ("apps/web/src/main.tsx").
 */
export interface RepoSource {
  /** All file paths relative to the repo root, with heavy dirs already pruned. */
  listFiles(): Promise<string[]>;
  /** Read a UTF-8 file by relative path; null if missing or binary. */
  readFile(relPath: string): Promise<string | null>;
}

/**
 * Minimal structural view of a sandbox the analyzer can read through. Kept
 * structural (not an import of @shipfix/sandbox) so the analyzer stays decoupled
 * from the execution boundary — any object with `list`/`readFile` works, which
 * is exactly what the @shipfix/sandbox `Sandbox` provides.
 */
export interface SandboxLike {
  list(globOrDir?: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

/**
 * Adapt a sandbox into a {@link RepoSource}. This is the seam that keeps repo
 * file access flowing through the sandbox boundary in production (E2B) and in
 * dev (LocalSandboxProvider) without the analyzer knowing the difference.
 */
export function repoSourceFromSandbox(sandbox: SandboxLike): RepoSource {
  return {
    listFiles: () => sandbox.list(),
    async readFile(relPath) {
      try {
        const text = await sandbox.readFile(relPath);
        return text.includes("\u0000") ? null : text;
      } catch {
        return null;
      }
    },
  };
}

/** Directories that never carry analysis signal and bloat the file tree. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".vercel",
  ".netlify",
  "coverage",
  ".idea",
  ".vscode",
  "vendor",
  "__pycache__",
]);

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Treat files containing NUL bytes as binary (skip them for text analysis). */
function looksBinary(text: string): boolean {
  return text.includes("\u0000");
}

/**
 * DEV/TEST RepoSource backed by the local filesystem.
 *
 * Reused by the analyzer test suite and (for now) by the dev sandbox path. It
 * walks a directory, skipping IGNORED_DIRS, and exposes the RepoSource surface.
 */
export function createLocalFsRepoSource(rootDir: string): RepoSource {
  const root = path.resolve(rootDir);

  async function walk(dir: string, acc: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), acc);
      } else if (entry.isFile()) {
        acc.push(toPosix(path.relative(root, path.join(dir, entry.name))));
      }
    }
  }

  return {
    async listFiles() {
      const acc: string[] = [];
      await walk(root, acc);
      acc.sort();
      return acc;
    },
    async readFile(relPath) {
      try {
        const text = await fs.readFile(path.join(root, relPath), "utf8");
        return looksBinary(text) ? null : text;
      } catch {
        return null;
      }
    },
  };
}
