import type { FileEdit, RepoFiles } from "../types";
import { normalizePath } from "../util";

export interface ProposedEdit {
  path: string;
  /** Exact text to replace; must occur exactly once. Omit to create a file (or rewrite a small one). */
  find?: string | undefined;
  replace: string;
}

const PROTECTED_RE =
  /(^|\/)(\.env(\..*)?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock)$|(^|\/)(\.git|\.github|node_modules)\//;
const MAX_EDITED_FILES = 8;
const MAX_REWRITE_LINES = 200;

/** Why a path may not be edited by the model, or null when it may. */
export function protectedPathReason(path: string): string | null {
  if (PROTECTED_RE.test(path)) return `${path} is a lockfile, secret file, or CI/VCS path that ShipFix never edits`;
  return null;
}

/**
 * Turn model-proposed edits into whole-file edits against the repo. Rejects
 * anything ambiguous instead of guessing, and reports why so the next attempt
 * can correct itself.
 */
export async function applyProposedEdits(
  files: RepoFiles,
  edits: ProposedEdit[],
): Promise<{ ok: true; files: FileEdit[] } | { ok: false; error: string }> {
  const known = new Set(await files.listFiles());
  const working = new Map<string, { before: string | null; after: string }>();

  for (const edit of edits) {
    const path = normalizePath(edit.path.replace(/\\/g, "/"));
    if (!path) return { ok: false, error: `Invalid path "${edit.path}".` };
    const blocked = protectedPathReason(path);
    if (blocked) return { ok: false, error: blocked };

    const prior = working.get(path);
    const current = prior ? prior.after : known.has(path) ? await files.readFile(path) : null;
    let next: string;
    if (edit.find !== undefined && edit.find !== "") {
      if (current === null) return { ok: false, error: `${path} does not exist, so "find" cannot match.` };
      const count = current.split(edit.find).length - 1;
      if (count !== 1) {
        return {
          ok: false,
          error: `In ${path}, the "find" text matched ${count} times; it must match exactly once (copy it verbatim, including whitespace).`,
        };
      }
      next = current.replace(edit.find, () => edit.replace);
    } else {
      if (current !== null && current.split("\n").length > MAX_REWRITE_LINES) {
        return { ok: false, error: `${path} is too long to rewrite whole; use "find"/"replace" for the changed lines.` };
      }
      next = edit.replace;
    }
    working.set(path, { before: prior ? prior.before : current, after: next });
  }

  const out = [...working.entries()]
    .filter(([, v]) => v.before !== v.after)
    .map(([path, v]) => ({ path, before: v.before, after: v.after }));
  if (out.length === 0) return { ok: false, error: "The edits did not change any file." };
  if (out.length > MAX_EDITED_FILES) return { ok: false, error: `Too many files changed (${out.length}); keep the fix minimal.` };
  return { ok: true, files: out };
}
