import type { ShipfixClient } from "./client";

const BUSY = new Set([
  "queued",
  "analyzing",
  "planning",
  "validating",
  "provisioning",
  "deploying",
  "wiring",
  "verifying",
]);

interface Question {
  id?: string;
  prompt?: string;
  kind?: string;
}

interface Snapshot {
  run?: { id?: string; status?: string; repoFullName?: string | null; branch?: string | null };
  plan?: { classification?: string; questions?: Question[] } | null;
  resources?: Array<{ serviceId?: string; url?: string | null; status?: string; role?: string }>;
  answeredQuestionIds?: string[];
  diagnoses?: Array<{ code?: string; action?: string }>;
}

function asSnapshot(value: unknown): Snapshot {
  return value && typeof value === "object" ? (value as Snapshot) : {};
}

function unanswered(snapshot: Snapshot): Question[] {
  const answered = new Set(snapshot.answeredQuestionIds ?? []);
  return (snapshot.plan?.questions ?? []).filter((q) => q.id && !answered.has(q.id));
}

/** Compact status an agent can read without the whole plan document. */
export function summarizeStatus(value: unknown): string {
  const snapshot = asSnapshot(value);
  const run = snapshot.run ?? {};
  const urls = (snapshot.resources ?? [])
    .filter((r) => r.url)
    .map((r) => `${r.role ?? r.serviceId}: ${r.url} (${r.status})`);
  const questions = unanswered(snapshot).map((q) => q.prompt).filter(Boolean);
  const lines = [
    `Run ${run.id ?? "unknown"} is ${run.status ?? "unknown"}.`,
    run.repoFullName ? `Repo: ${run.repoFullName}${run.branch ? ` (${run.branch})` : ""}` : "",
    snapshot.plan?.classification ? `Plan: ${snapshot.plan.classification}` : "",
    urls.length ? `Live:\n${urls.map((u) => `- ${u}`).join("\n")}` : "",
    questions.length ? `Waiting for answers:\n${questions.map((q) => `- ${q}`).join("\n")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export async function deployTool(client: ShipfixClient, repo: string, branch?: string): Promise<string> {
  const body = (await client.deploy({ repo, branch })) as { runId?: string; mode?: string };
  return `Deploy started. runId: ${body.runId ?? "unknown"}. Check status with that id.`;
}

export async function statusTool(client: ShipfixClient, runId: string): Promise<string> {
  return summarizeStatus(await client.status(runId));
}

export async function logsTool(client: ShipfixClient, runId: string, limit?: number): Promise<string> {
  const { lines } = await client.logs(runId, limit);
  if (!lines.length) return "No log lines yet.";
  return lines.map((l) => `[${l.level}] ${l.message}`).join("\n");
}

/**
 * Ask ShipFix to repair a failed deploy. A run that is waiting on the user
 * is not redeployed; the agent is told which answers are missing.
 */
export async function fixTool(client: ShipfixClient, runId: string): Promise<string> {
  const snapshot = asSnapshot(await client.status(runId));
  const status = snapshot.run?.status;
  if (status === "awaiting_input") {
    const questions = unanswered(snapshot).map((q) => q.prompt).filter(Boolean);
    return questions.length
      ? `This deploy is waiting for you, not a code fix.\n${questions.map((q) => `- ${q}`).join("\n")}`
      : "This deploy is waiting for an answer. Open the run and submit it there.";
  }
  if (status === "succeeded") return "This deploy already succeeded. Nothing to fix.";
  if (status && BUSY.has(status)) return `This deploy is still ${status}. Wait, then check status.`;
  if (status === "failed" || status === "diagnosed") {
    const body = (await client.redeploy(runId)) as { runId?: string };
    return `Repair started by redeploying run ${body.runId ?? runId}. ShipFix will try a tested fix and redeploy. Check status with that id.`;
  }
  return `ShipFix can't start a fix while the run is ${status ?? "unknown"}.`;
}
