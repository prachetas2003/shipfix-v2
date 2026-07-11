/**
 * Local E2E helper: connect providers (if needed) and start a deploy run.
 * Usage: node --env-file=.env scripts/e2e-deploy-once.mjs [owner/repo]
 */
const API = process.env.SHIPFIX_API ?? "http://localhost:4000";
const REPO = process.argv[2] ?? "prachetas2003/shipfix-e2e-demo";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 15 * 60_000);

const log = (...a) => console.log("[e2e]", ...a);

async function json(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function ensureProviders() {
  const { body: providers } = await json("/providers");
  log("providers connected:", (providers.connected ?? []).join(",") || "(none)");
  const need = {
    neon: {
      apiKey: process.env.NEON_API_KEY,
      orgId: process.env.NEON_ORG_ID,
    },
    render: { apiKey: process.env.RENDER_API_KEY },
    vercel: { apiToken: process.env.VERCEL_TOKEN },
  };
  for (const [provider, values] of Object.entries(need)) {
    if ((providers.connected ?? []).includes(provider)) continue;
    const missing = Object.entries(values)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) {
      throw new Error(`Missing env for ${provider}: ${missing.join(", ")}`);
    }
    const { res, body } = await json("/provider-accounts", {
      method: "POST",
      body: JSON.stringify({ provider, values }),
    });
    if (!res.ok) {
      throw new Error(`Connect ${provider} failed HTTP ${res.status}: ${JSON.stringify(body)}`);
    }
    log(`connected ${provider}`);
  }
}

async function main() {
  log(`API=${API} repo=${REPO}`);
  const health = await fetch(`${API}/health`);
  if (!health.ok) throw new Error(`API unhealthy: ${health.status}`);

  await ensureProviders();

  const { res, body } = await json("/runs/deploy", {
    method: "POST",
    body: JSON.stringify({ repoFullName: REPO, branch: "main" }),
  });
  if (res.status !== 202) {
    throw new Error(`POST /runs/deploy -> HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  const runId = body.runId;
  log(`deploy started: ${runId}`);
  log(`UI: http://localhost:3000/runs/${runId}`);

  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    const { res: sRes, body: snap } = await json(`/runs/${runId}`);
    if (!sRes.ok) throw new Error(`GET /runs/${runId} -> ${sRes.status}`);
    const status = snap.run?.status ?? snap.status;
    const live = Boolean(snap.layers?.fullStack?.live);
    log(`status=${status} fullStackLive=${live}`);
    if (["succeeded", "diagnosed", "failed"].includes(status)) {
      console.log(
        JSON.stringify(
          {
            runId,
            status,
            layers: snap.layers,
            resources: (snap.resources ?? []).map((r) => ({
              role: r.role,
              provider: r.provider,
              status: r.status,
              url: r.url,
            })),
            verification: snap.verification,
          },
          null,
          2,
        ),
      );
      if (status === "failed") process.exit(1);
      return;
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error(`Timed out after ${TIMEOUT_MS}ms waiting for run ${runId}`);
}

main().catch((e) => {
  console.error("[e2e] ERROR:", e.message);
  process.exit(1);
});
