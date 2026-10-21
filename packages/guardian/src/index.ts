export interface ProbeTarget {
  serviceId: string;
  url: string;
  healthPath?: string | null;
}

export interface ProbeResult {
  serviceId: string;
  url: string;
  ok: boolean;
  status: number | null;
  detail: string;
}

export interface GuardianCheck {
  ok: boolean;
  lines: string[];
  results: ProbeResult[];
}

export interface HistoryCommit {
  status: string;
  commitSha: string;
}

const HTTP = /^https?:\/\//i;

/** Public URL plus the plan's health path. Non-HTTP targets are skipped by the caller. */
export function probeUrl(target: ProbeTarget): string {
  const base = target.url.replace(/\/$/, "");
  const path = target.healthPath?.trim();
  if (!path || path === "/") return base;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function probeHealth(
  targets: ProbeTarget[],
  fetchImpl: typeof fetch,
  timeoutMs = 8_000,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const target of targets) {
    if (!HTTP.test(target.url)) continue;
    const url = probeUrl(target);
    try {
      const res = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
      const ok = res.status >= 200 && res.status < 400;
      results.push({
        serviceId: target.serviceId,
        url,
        ok,
        status: res.status,
        detail: ok ? `${target.serviceId} answered ${res.status}` : `${target.serviceId} returned ${res.status}`,
      });
    } catch {
      results.push({
        serviceId: target.serviceId,
        url,
        ok: false,
        status: null,
        detail: `${target.serviceId} did not answer`,
      });
    }
  }
  return results;
}

export function summarizeCheck(results: ProbeResult[]): GuardianCheck {
  const ok = results.length > 0 && results.every((result) => result.ok);
  const lines = results.length
    ? results.map((result) => result.detail)
    : ["No live URL to check."];
  return { ok: results.length === 0 ? true : ok, lines, results };
}

/** Previous succeeded commit that is not the one currently live. History is newest first. */
export function rollbackCommit(history: HistoryCommit[], currentSha: string): string | null {
  const previous = history.find((run) => run.status === "succeeded" && run.commitSha && run.commitSha !== currentSha);
  return previous?.commitSha ?? null;
}

export {
  billAlertText,
  billLines,
  capStanding,
  detectSpendSpike,
  formatCents,
  httpSpendNote,
  measuredSpendCents,
  NO_MOVE_NOTE,
  parseFocusCharges,
  parseRenderBandwidth,
  runCostCents,
  suggestCheaperMove,
  trafficFloor,
  UNREADABLE_PROVIDER_NOTES,
  usageSpike,
  type CapStanding,
  type MoneyRead,
  type MoveHost,
  type MoveService,
} from "./bills";

export {
  ONE_ENVIRONMENT_NOTE,
  attachHostname,
  backupTarget,
  deleteProviderResource,
  domainTarget,
  planTeardown,
  validHostname,
  type OwnedResource,
  type ProviderCreds,
  type TeardownStep,
} from "./extras";

export function incidentText(repo: string, check: GuardianCheck): string {
  const down = check.results.filter((result) => !result.ok);
  if (down.length === 0) return `${repo} is up.`;
  return `${repo} needs attention.\n${down.map((result) => result.detail).join("\n")}`;
}

/** Posts a Slack incoming-webhook message. The webhook URL is never included in the error. */
export async function notifySlack(webhook: string, text: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
