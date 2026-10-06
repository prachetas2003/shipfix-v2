/**
 * Live mode: drive real deploy runs through the ShipFix API and measure the
 * numbers users feel — did it go live on the first try, and how long did it take.
 */

export type LiveOutcome = "succeeded" | "diagnosed" | "failed" | "awaiting_input" | "start_failed" | "timeout";

export interface LiveRunResult {
  id: string;
  runId: string | null;
  outcome: LiveOutcome;
  /** Wall-clock from POST /runs/deploy to a terminal status. */
  durationMs: number;
  error?: string;
}

export interface LiveOptions {
  apiUrl: string;
  token: string;
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
}

const TERMINAL = new Set(["succeeded", "diagnosed", "failed", "awaiting_input"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function driveLiveRun(repo: string, opts: LiveOptions): Promise<LiveRunResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" };
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const pollMs = opts.pollMs ?? 10_000;

  const res = await fetchImpl(`${base}/runs/deploy`, {
    method: "POST",
    headers,
    body: JSON.stringify({ repoFullName: repo }),
  }).catch((err: unknown) => err as Error);
  if (res instanceof Error || !res.ok) {
    const error = res instanceof Error ? res.message : `${res.status} ${(await res.text()).slice(0, 200)}`;
    return { id: repo, runId: null, outcome: "start_failed", durationMs: Date.now() - started, error };
  }
  const { runId } = (await res.json()) as { runId: string };

  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    const snap = await fetchImpl(`${base}/runs/${runId}`, { headers }).catch(() => null);
    if (!snap?.ok) continue;
    const body = (await snap.json()) as { run?: { status?: string } };
    const status = body.run?.status;
    if (status && TERMINAL.has(status)) {
      return { id: repo, runId, outcome: status as LiveOutcome, durationMs: Date.now() - started };
    }
  }
  return { id: repo, runId, outcome: "timeout", durationMs: Date.now() - started };
}

export interface LiveSummary {
  total: number;
  firstTryLiveRate: number;
  outcomes: Record<LiveOutcome, number>;
  timeToLiveP50Ms: number;
  timeToLiveP90Ms: number;
}

export function summarizeLive(results: LiveRunResult[]): LiveSummary {
  const outcomes: Record<LiveOutcome, number> = {
    succeeded: 0,
    diagnosed: 0,
    failed: 0,
    awaiting_input: 0,
    start_failed: 0,
    timeout: 0,
  };
  for (const r of results) outcomes[r.outcome]++;
  const live = results.filter((r) => r.outcome === "succeeded").map((r) => r.durationMs).sort((a, b) => a - b);
  const pick = (p: number) => (live.length ? live[Math.min(live.length - 1, Math.ceil(p * live.length) - 1)] : 0);
  return {
    total: results.length,
    firstTryLiveRate: results.length ? Math.round((outcomes.succeeded / results.length) * 1000) / 1000 : 0,
    outcomes,
    timeToLiveP50Ms: pick(0.5),
    timeToLiveP90Ms: pick(0.9),
  };
}
