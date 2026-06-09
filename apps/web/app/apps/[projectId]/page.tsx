"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { api, type AppDetail } from "../../lib/api";
import { buildAppResourceDisplay } from "../../lib/resourceDisplay";
import { deriveRequiredProviders, missingProviders } from "../../lib/planRequirements";
import { runModeLabel, runStatusLabel } from "../../lib/runLabels";
import { buttonStyle, colors, h2, mono } from "../../lib/theme";
import { CurrentState } from "../../components/CurrentState";
import { ProviderRequirements } from "../../components/ProviderRequirements";

const STATUS_COLOR: Record<string, string> = {
  succeeded: colors.success,
  diagnosed: colors.warn,
  failed: colors.error,
};

export default function AppDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): React.ReactElement {
  const { projectId } = use(params);
  const router = useRouter();
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const [showConnect, setShowConnect] = useState(false);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [app, providers] = await Promise.all([api.getApp(projectId), api.listProviders()]);
      setDetail(app);
      setConnected(providers.connected);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  const visibleDeployment = detail?.latestLiveDeployment ?? detail?.current;
  const display =
    visibleDeployment &&
    buildAppResourceDisplay({
      resources: visibleDeployment.resources,
      layers: visibleDeployment.layers,
      verification: visibleDeployment.verification,
    });

  const noLiveDeployment = !detail?.latestLiveDeployment && !display?.fullStack.live;
  const action = detail?.deployAction ?? null;
  const latestRunNeedsDeployAction =
    detail?.history[0]?.mode === "deploy" &&
    (detail.history[0].status === "failed" || detail.history[0].status === "diagnosed");
  const showDeployAction = Boolean(action && (noLiveDeployment || latestRunNeedsDeployAction));
  const startDeploy = async () => {
    if (!action) return;
    setErr(null);
    const providers = await api.listProviders().catch(() => ({ connected }));
    setConnected(providers.connected);
    const requiredPlanMissing = missingProviders(deriveRequiredProviders(action.plan), providers.connected);
    if (requiredPlanMissing.length > 0) {
      setShowConnect(true);
      return;
    }
    setStarting(true);
    try {
      const runId = await api.startDeployFromRun(action.sourceRunId);
      router.push(`/runs/${runId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "2.5rem 1.5rem 6rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: "1rem", flexWrap: "wrap" }}>
        <Link href="/" style={{ color: colors.dim, textDecoration: "none", fontSize: "0.85rem" }}>
          Back to My Apps
        </Link>
        <h1 style={{ fontSize: "1.5rem", margin: 0, fontFamily: mono }}>
          {detail?.project.repoFullName ?? "App"}
        </h1>
        <Link href="/new" style={{ marginLeft: "auto", textDecoration: "none", color: colors.accentText, fontSize: "0.9rem" }}>
          New deployment
        </Link>
      </div>

      {err && <p style={{ color: colors.error }}>{err}</p>}

      {showDeployAction && action && (
        <section style={{ margin: "1rem 0 1.5rem" }}>
          <p style={{ color: colors.warn, fontWeight: 600, marginBottom: "0.75rem" }}>
            {latestRunNeedsDeployAction ? "Latest deploy did not finish. The previous live deployment is preserved below." : "Plan ready, but app is not deployed yet."}
          </p>
          <button onClick={() => void startDeploy()} disabled={starting} style={buttonStyle("primary", starting)}>
            {starting ? "Starting deploy..." : action.label}
          </button>
          {showConnect && (
            <ProviderRequirements plan={action.plan} connected={connected} onConnected={() => void load()} />
          )}
        </section>
      )}

      {display && (
        <div style={{ marginBottom: "2rem" }}>
          {detail?.latestLiveDeployment && detail.current?.runId !== detail.latestLiveDeployment.runId && (
            <p style={{ color: colors.warn, fontSize: "0.88rem", marginTop: 0 }}>
              Latest run is {runStatusLabel(detail.history[0]?.mode ?? "", detail.history[0]?.status ?? "")}. Showing the most recent live deployment links below.
            </p>
          )}
          <CurrentState display={display} />
        </div>
      )}

      <section>
        <h2 style={h2}>Deployment history</h2>
        {detail?.history.length === 0 && <p style={{ opacity: 0.6 }}>No runs yet.</p>}
        <div style={{ marginTop: "0.75rem" }}>
          {detail?.history.map((r) => (
            <Link key={r.id} href={`/runs/${r.id}`} style={{ textDecoration: "none", color: "inherit" }}>
              <div
                style={{
                  background: colors.card,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 10,
                  padding: "1rem",
                  marginBottom: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    fontSize: "0.7rem",
                    fontWeight: 700,
                    color: "#0b0b0b",
                    background: STATUS_COLOR[r.status] ?? colors.dim,
                    padding: "0.1rem 0.5rem",
                    borderRadius: 999,
                    minWidth: 112,
                    textAlign: "center",
                  }}
                >
                  {runStatusLabel(r.mode, r.status)}
                </span>
                <span style={{ opacity: 0.75, fontSize: "0.85rem" }}>{runModeLabel(r.mode)}</span>
                <span style={{ opacity: 0.5, fontSize: "0.8rem", fontFamily: mono }}>{r.commitSha.slice(0, 8)}</span>
                <span style={{ marginLeft: "auto", opacity: 0.5, fontSize: "0.8rem" }}>
                  {new Date(r.startedAt).toLocaleString()}
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
