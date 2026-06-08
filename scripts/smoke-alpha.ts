/**
 * Real-provider alpha smoke test. This intentionally calls the running API and
 * never fakes deployment success.
 *
 * Usage:
 *   CLERK_SESSION_TOKEN=... SHIPFIX_ADMIN_TOKEN=... pnpm smoke:alpha -- --api http://localhost:4000 --repo owner/repo --mode deploy
 */

type Args = {
  api: string;
  repo: string;
  mode: "plan" | "deploy";
  expect: "terminal" | "succeeded" | "full-stack";
  timeoutMs: number;
};

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function parseArgs(): Args {
  const mode = (arg("mode") ?? "deploy") as Args["mode"];
  const expect = (arg("expect") ?? (mode === "deploy" ? "full-stack" : "terminal")) as Args["expect"];
  const repo = arg("repo");
  if (!repo) throw new Error("Missing --repo owner/name");
  if (mode !== "plan" && mode !== "deploy") throw new Error("--mode must be plan or deploy");
  if (!["terminal", "succeeded", "full-stack"].includes(expect)) {
    throw new Error("--expect must be terminal, succeeded, or full-stack");
  }
  return {
    api: (arg("api") ?? "http://localhost:4000").replace(/\/$/, ""),
    repo,
    mode,
    expect,
    timeoutMs: Number(arg("timeout-ms") ?? 20 * 60 * 1000),
  };
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${url} failed: ${res.status} ${body.message ?? body.error ?? ""}`);
  }
  return body as T;
}

const args = parseArgs();
const userToken = process.env.CLERK_SESSION_TOKEN;
const adminToken = process.env.SHIPFIX_ADMIN_TOKEN;
if (!userToken) throw new Error("CLERK_SESSION_TOKEN is required for smoke:alpha.");
if (!adminToken) throw new Error("SHIPFIX_ADMIN_TOKEN is required for smoke:alpha.");

const userHeaders = { Authorization: `Bearer ${userToken}` };
const adminHeaders = { "X-ShipFix-Admin-Token": adminToken };

const config = await requestJson<Record<string, unknown>>(`${args.api}/admin/config-check`, {
  headers: adminHeaders,
});
console.log("[smoke] config-check", JSON.stringify(config));

const started = await requestJson<{ runId: string }>(`${args.api}/runs/${args.mode}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...userHeaders },
  body: JSON.stringify({ repoFullName: args.repo }),
});
console.log(`[smoke] started ${args.mode} run ${started.runId}`);

const terminal = new Set(["succeeded", "diagnosed", "failed"]);
const deadline = Date.now() + args.timeoutMs;
let snapshot: any = null;
while (Date.now() < deadline) {
  snapshot = await requestJson<any>(`${args.api}/runs/${started.runId}`, { headers: userHeaders });
  const status = snapshot.run?.status;
  console.log(`[smoke] status=${status} fullStack=${Boolean(snapshot.layers?.fullStack?.live)}`);
  if (terminal.has(status)) break;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

if (!snapshot || !terminal.has(snapshot.run?.status)) {
  throw new Error(`Run ${started.runId} did not reach a terminal status before timeout.`);
}
if (args.expect === "succeeded" && snapshot.run.status !== "succeeded") {
  throw new Error(`Expected succeeded, got ${snapshot.run.status}.`);
}
if (args.expect === "full-stack" && !snapshot.layers?.fullStack?.live) {
  throw new Error(`Expected full-stack live, got status=${snapshot.run.status}: ${snapshot.layers?.fullStack?.detail ?? ""}`);
}

console.log("[smoke] passed", JSON.stringify({ runId: started.runId, status: snapshot.run.status }));
