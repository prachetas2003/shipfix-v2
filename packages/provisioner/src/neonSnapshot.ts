/**
 * Snapshot a Neon database before ShipFix migrates it: a copy-on-write branch
 * of the default branch at this moment, without compute, so it costs only the
 * storage that later diverges. Restoring is "reset main from this branch" in
 * the Neon console. Old ShipFix snapshots are pruned to stay under branch limits.
 */

const NEON_API = "https://console.neon.tech/api/v2";
export const NEON_SNAPSHOT_PREFIX = "shipfix-pre-migrate-";
export const NEON_BACKUP_PREFIX = "shipfix-backup-";

export interface NeonSnapshotOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
  /** ShipFix snapshots to keep, including the new one. */
  keep?: number;
  now?: () => Date;
  /** Branch-name prefix. Defaults to the pre-migrate prefix so older callers are unchanged. */
  prefix?: string;
}

interface NeonBranch {
  id?: string;
  name?: string;
  created_at?: string;
  default?: boolean;
  primary?: boolean;
}

export type NeonSnapshotResult = { ok: true; branchName: string; branchId: string; pruned: number } | { ok: false; message: string };

async function neonCall(
  method: "GET" | "POST" | "DELETE",
  path: string,
  apiKey: string,
  opts: NeonSnapshotOptions,
  payload?: unknown,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.apiBase ?? NEON_API}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: e instanceof Error && e.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

function neonError(action: string, status: number, body: unknown): string {
  const msg = body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
    ? `: ${(body as { message: string }).message.slice(0, 200)}`
    : "";
  return `Neon could not ${action} (HTTP ${status || "network"})${msg}`;
}

export async function snapshotNeonDatabase(
  apiKey: string,
  projectId: string,
  opts: NeonSnapshotOptions = {},
): Promise<NeonSnapshotResult> {
  const project = `/projects/${encodeURIComponent(projectId)}`;
  const prefix = opts.prefix ?? NEON_SNAPSHOT_PREFIX;
  const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "z").toLowerCase();
  const branchName = `${prefix}${stamp}`;

  const keep = Math.max(1, opts.keep ?? 3);
  let pruned = 0;
  const list = await neonCall("GET", `${project}/branches`, apiKey, opts);
  if (list.status === 200) {
    const ours = ((list.body as { branches?: NeonBranch[] } | null)?.branches ?? [])
      .filter((b) => b.id && b.name?.startsWith(prefix) && !b.default && !b.primary)
      .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
    for (const b of ours.slice(0, Math.max(0, ours.length - (keep - 1)))) {
      const del = await neonCall("DELETE", `${project}/branches/${encodeURIComponent(b.id!)}`, apiKey, opts);
      if (del.status >= 200 && del.status < 300) pruned++;
    }
  }

  const created = await neonCall("POST", `${project}/branches`, apiKey, opts, { branch: { name: branchName } });
  const branchId = (created.body as { branch?: NeonBranch } | null)?.branch?.id;
  if (created.status < 200 || created.status >= 300 || !branchId) {
    return { ok: false, message: neonError("create a snapshot branch", created.status, created.body) };
  }
  return { ok: true, branchName, branchId, pruned };
}

export function isShipfixBranchName(name: string): boolean {
  return name.startsWith(NEON_SNAPSHOT_PREFIX) || name.startsWith(NEON_BACKUP_PREFIX);
}

/**
 * Replace the default branch with a ShipFix snapshot or backup branch.
 * The current default is kept under a new name. Other branch names are refused.
 */
export async function restoreNeonBranch(
  apiKey: string,
  projectId: string,
  sourceBranchName: string,
  opts: NeonSnapshotOptions = {},
): Promise<NeonSnapshotResult> {
  if (!isShipfixBranchName(sourceBranchName)) {
    return { ok: false, message: "ShipFix only restores a branch it created." };
  }
  const project = `/projects/${encodeURIComponent(projectId)}`;
  const list = await neonCall("GET", `${project}/branches`, apiKey, opts);
  if (list.status !== 200) return { ok: false, message: neonError("list branches", list.status, list.body) };
  const branches = (list.body as { branches?: NeonBranch[] } | null)?.branches ?? [];
  const source = branches.find((branch) => branch.name === sourceBranchName && branch.id && !branch.default && !branch.primary);
  const target = branches.find((branch) => branch.default && branch.id) ?? branches.find((branch) => branch.primary && branch.id);
  if (!source?.id || !target?.id) return { ok: false, message: "That backup branch is not on this Neon project." };
  const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "z").toLowerCase();
  const preserved = `shipfix-before-restore-${stamp}`;
  const restored = await neonCall("POST", `${project}/branches/${encodeURIComponent(target.id)}/restore`, apiKey, opts, {
    source_branch_id: source.id,
    preserve_under_name: preserved,
  });
  if (restored.status < 200 || restored.status >= 300) {
    return { ok: false, message: neonError("restore the branch", restored.status, restored.body) };
  }
  return { ok: true, branchName: preserved, branchId: target.id, pruned: 0 };
}
