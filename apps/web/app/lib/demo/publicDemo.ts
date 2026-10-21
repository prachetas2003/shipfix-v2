import appsJson from "./apps.json";
import appJson from "./app.json";
import runJson from "./run.json";

export const DEMO = process.env.NEXT_PUBLIC_DEMO === "1";

export const DEMO_MESSAGE =
  "This is a recorded demo of a finished deploy. The live site links are real. Buttons that would redeploy, change, or delete the app are turned off.";

const SUCCESS_RUN = "c37b7ea5-86a8-44b2-8ccf-ae17b93f073f";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function runSnapshot(runId: string): unknown {
  if (runId === SUCCESS_RUN) return runJson;
  const history = (appJson as { history: Array<{ id: string; mode: string; status: string; commitSha: string; startedAt: string; finishedAt: string | null }> }).history;
  const row = history.find((item) => item.id === runId);
  const base = runJson as { run: Record<string, unknown> };
  return {
    ...runJson,
    run: {
      ...base.run,
      id: runId,
      mode: row?.mode ?? "deploy",
      status: row?.status ?? "diagnosed",
      commitSha: row?.commitSha ?? base.run.commitSha,
      startedAt: row?.startedAt ?? base.run.startedAt,
      finishedAt: row?.finishedAt ?? base.run.finishedAt,
    },
    diagnoses: row?.status === "succeeded" ? [] : [{ code: "recorded_demo", action: "Shown from the recorded deploy. Nothing is running again." }],
  };
}

export function demoGet(path: string): unknown {
  const clean = path.split("?")[0] ?? path;
  if (clean === "/apps") return appsJson;
  if (clean === "/providers") {
    return { connected: ["vercel", "render", "neon"], provisionable: ["vercel", "render", "neon"], deployable: ["vercel", "render", "neon"] };
  }
  if (clean === "/providers/oauth") return { providers: [] };
  if (clean === "/github/repos") return { configured: false, repos: [] };
  if (clean === "/github/installations") {
    return { configured: false, claimable: false, installUrl: null, installations: [] };
  }
  if (clean.startsWith("/runs/")) return runSnapshot(clean.slice("/runs/".length));
  if (clean.endsWith("/env")) return { vars: [] };
  if (clean.startsWith("/apps/")) return appJson;
  return { ok: true };
}

function demoResponse(url: string, method: string): Response {
  const path = new URL(url, "http://localhost").pathname;
  if (method === "GET") return jsonResponse(demoGet(path));
  if (method === "POST" && path.endsWith("/guardian/check")) {
    return jsonResponse({ ok: true, lines: ["api answered 200", "web answered 200"], alertSent: false });
  }
  if (method === "POST" && path.endsWith("/guardian/bills")) {
    return jsonResponse({
      lines: ["Recorded demo. No card is charged."],
      spike: false,
      over: false,
      alertSent: false,
      capCents: null,
    });
  }
  return jsonResponse({ message: DEMO_MESSAGE }, 403);
}

let installed = false;

/** Keep a public demo from calling the real API on this computer. */
export function installPublicDemo(): void {
  if (!DEMO || installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    if (!url.startsWith(apiBase)) return original(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    return demoResponse(url, method);
  };
}
