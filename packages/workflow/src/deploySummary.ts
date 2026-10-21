import type { DeploySummary } from "./finalizeDeployRun";

/**
 * Fold a redeploy (after a repair) into the first pass. The retry decides the
 * status of every service it actually attempted; "already_deployed" skips
 * carry no news, so the first pass stands for those.
 */
export function mergeDeploySummary(first: DeploySummary, retry: DeploySummary): DeploySummary {
  const status = new Map<string, { kind: "deployed" } | { kind: "failed"; entry: DeploySummary["failed"][number] } | { kind: "skipped"; reason: string }>();
  const apply = (s: DeploySummary, isRetry: boolean) => {
    for (const id of s.deployed) status.set(id, { kind: "deployed" });
    for (const f of s.failed) status.set(f.id, { kind: "failed", entry: f });
    for (const k of s.skipped) {
      if (isRetry && k.reason === "already_deployed" && status.has(k.id)) continue;
      status.set(k.id, { kind: "skipped", reason: k.reason });
    }
  };
  apply(first, false);
  apply(retry, true);

  const out: DeploySummary = { deployed: [], failed: [], skipped: [] };
  for (const [id, s] of status) {
    if (s.kind === "deployed") out.deployed.push(id);
    else if (s.kind === "failed") out.failed.push(s.entry);
    else out.skipped.push({ id, reason: s.reason });
  }
  return out;
}
