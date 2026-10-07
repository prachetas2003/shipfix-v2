import type { ServiceSignal } from "@shipfix/contracts";
import type { RepoSource } from "./source";
import { joinRoot, MAX_SCAN_BYTES } from "./util";

type WorkerProcess = NonNullable<ServiceSignal["workers"]>[number];

/** Production entry points for a background process; dev/watch variants are excluded. */
const WORKER_SCRIPT_RE = /^(worker|workers|start:worker|worker:start|worker:prod|start-worker|queue|queue:work)$/;
/** Scripts named "worker" that build or serve something else (Cloudflare Workers, bundlers). */
const NOT_A_PROCESS_RE = /\b(wrangler|vite|next|tsc|webpack|esbuild|tsup|--watch|nodemon)\b/;

export function scriptWorkers(scripts: Record<string, string>, pkgPath: string): WorkerProcess[] {
  return Object.entries(scripts)
    .filter(([name, cmd]) => WORKER_SCRIPT_RE.test(name) && !NOT_A_PROCESS_RE.test(cmd))
    .slice(0, 1)
    .map(([name]) => ({ name: "worker", script: name, evidence: [`${pkgPath}: "${name}" script`] }));
}

/** Non-web Procfile processes (`worker: celery -A app worker`); `release` is a one-off, not a process. */
export async function procfileWorkers(
  source: RepoSource,
  files: ReadonlySet<string>,
  rootDir: string,
): Promise<WorkerProcess[]> {
  const procfile = joinRoot(rootDir, "Procfile");
  if (!files.has(procfile)) return [];
  const text = ((await source.readFile(procfile)) ?? "").slice(0, MAX_SCAN_BYTES);
  const out: WorkerProcess[] = [];
  for (const m of text.matchAll(/^([\w-]+):\s*(.+)$/gm)) {
    const [, name, command] = m;
    if (name === "web" || name === "release") continue;
    out.push({ name, command: command.trim(), evidence: [`${procfile}: ${name} process`] });
  }
  return out.slice(0, 3);
}
