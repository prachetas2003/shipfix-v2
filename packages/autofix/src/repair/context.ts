import type { LogDiagnosis } from "@shipfix/adapter-core";
import type { FixService, RepoFiles } from "../types";
import { joinRoot } from "../util";
import { protectedPathReason } from "./edits";

export interface ContextFile {
  path: string;
  content: string;
  truncated: boolean;
}

const LOG_PATH_RE =
  /((?:[A-Za-z]:)?[\w@.~[\]()-]*(?:\/[\w@.~[\]()-]+)+\.(?:[cm]?[jt]sx?|json|py|vue|svelte|astro|prisma|toml|cfg|ini|ya?ml|css|scss)|\b[\w@.-]+\.(?:[cm]?[jt]sx?|py|vue|svelte|astro|prisma))/g;
const MAX_FILES = 8;
const MAX_FILE_CHARS = 24_000;
const MAX_TOTAL_CHARS = 80_000;

/** Map a path seen in a build log (often absolute on the build machine) to a repo file. */
export function resolveLogPath(raw: string, repoFiles: readonly string[], rootDir: string): string | null {
  const p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (p.includes("node_modules/")) return null;
  if (repoFiles.includes(p)) return p;
  const rooted = joinRoot(rootDir, p);
  if (repoFiles.includes(rooted)) return rooted;
  const suffixHits = repoFiles.filter((f) => p.endsWith(`/${f}`) || f.endsWith(`/${p}`));
  if (suffixHits.length === 1) return suffixHits[0]!;
  const inRoot = suffixHits.filter((f) => !rootDir || f.startsWith(`${rootDir}/`));
  return inRoot.length === 1 ? inRoot[0]! : null;
}

function manifestFor(service: FixService, kind: LogDiagnosis["kind"]): string[] {
  const r = (f: string) => joinRoot(service.rootDir, f);
  const python = kind === "python_dependency" || kind === "python_import";
  const base = python
    ? [r("requirements.txt"), r("pyproject.toml")]
    : [r("package.json")];
  if (kind === "typescript_error") base.push(r("tsconfig.json"));
  return base;
}

/**
 * The files a model needs to fix this failure: the ones the log points at,
 * plus the service manifest. Bounded so prompts stay small and cheap.
 */
export async function selectContextFiles(
  files: RepoFiles,
  service: FixService,
  diagnosis: LogDiagnosis,
  logText: string,
): Promise<ContextFile[]> {
  const all = await files.listFiles();
  const picked: string[] = [];
  const add = (p: string | null) => {
    if (p && !picked.includes(p) && !protectedPathReason(p) && picked.length < MAX_FILES) picked.push(p);
  };

  for (const line of [...diagnosis.evidence, ...logText.split("\n").slice(-200)]) {
    for (const m of line.matchAll(LOG_PATH_RE)) add(resolveLogPath(m[1]!, all, service.rootDir));
  }
  for (const f of manifestFor(service, diagnosis.kind)) if (all.includes(f)) add(f);

  const out: ContextFile[] = [];
  let total = 0;
  for (const path of picked) {
    const content = await files.readFile(path);
    if (content === null) continue;
    const truncated = content.length > MAX_FILE_CHARS;
    const body = truncated ? content.slice(0, MAX_FILE_CHARS) : content;
    if (total + body.length > MAX_TOTAL_CHARS) break;
    total += body.length;
    out.push({ path, content: body, truncated });
  }
  return out;
}
