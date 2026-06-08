#!/usr/bin/env node
/**
 * analyze_only smoke test — exercises the REAL spine end to end:
 *   POST /runs/analyze -> Temporal workflow -> dev sandbox clone -> analyzer
 *   -> run_events in Postgres -> SSE -> terminal status.
 *
 * Prereqs (all must be running): Postgres (schema pushed), Temporal dev server,
 * `pnpm dev:api`, and `pnpm dev:worker`.
 *
 * Usage:
 *   node scripts/smoke-analyze.mjs [owner/repo | https://github.com/owner/repo]
 *
 * Env:
 *   SHIPFIX_API        API base URL (default http://localhost:4000)
 *   SMOKE_TIMEOUT_MS   overall timeout (default 120000)
 *
 * Exit code 0 = analysis succeeded AND a RepoContext was streamed; 1 otherwise.
 */

const API = process.env.SHIPFIX_API ?? "http://localhost:4000";
const REPO = process.argv[2] ?? "octocat/Hello-World";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);

const log = (...a) => console.log("[smoke]", ...a);

function bodyFor(repo) {
  return /^https?:\/\//i.test(repo) ? { repoUrl: repo } : { repoFullName: repo };
}

async function main() {
  log(`API=${API}  repo=${REPO}  timeout=${TIMEOUT_MS}ms`);

  // 1) API reachable?
  let health;
  try {
    health = await fetch(`${API}/health`);
  } catch (e) {
    throw new Error(`API not reachable at ${API} (is 'pnpm dev:api' running?): ${e.message}`);
  }
  if (!health.ok) throw new Error(`/health returned HTTP ${health.status}`);
  log("API healthy");

  // 2) Start an analyze_only run.
  const res = await fetch(`${API}/runs/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyFor(REPO)),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 202) {
    throw new Error(`POST /runs/analyze -> HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  const runId = body.runId;
  log(`run started: ${runId}`);

  // 3) Stream the SSE timeline until a terminal "end" event.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const stream = await fetch(`${API}/runs/${runId}/events`, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!stream.ok || !stream.body) throw new Error(`SSE connect failed: HTTP ${stream.status}`);

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finalStatus = null;
  let sawRepoContext = false;
  let serviceCount = 0;
  let eventCount = 0;

  outer: while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      let evt = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue; // keepalive comment
        if (line.startsWith("event:")) evt = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }

      if (evt === "run_event") {
        eventCount++;
        const row = JSON.parse(data);
        const tag = row.data && row.data.event ? row.data.event : row.stage || row.type;
        log(`  #${row.seq} ${row.level.padEnd(5)} ${tag}: ${row.message}`);
        if (row.data?.event === "service_detected") serviceCount++;
        if (row.data?.event === "analysis_completed" && row.data.repoContext) sawRepoContext = true;
      } else if (evt === "end") {
        finalStatus = JSON.parse(data).status;
        break outer;
      }
    }
  }
  clearTimeout(timer);

  log("──────────────────────────────────────────");
  log(`events received : ${eventCount}`);
  log(`services found  : ${serviceCount}`);
  log(`RepoContext sent: ${sawRepoContext}`);
  log(`final status    : ${finalStatus}`);

  if (finalStatus === "succeeded" && sawRepoContext) {
    log("SMOKE PASS ✓");
    process.exit(0);
  }
  log("SMOKE FAIL ✗");
  process.exit(1);
}

main().catch((e) => {
  console.error("[smoke] ERROR:", e.message);
  process.exit(1);
});
