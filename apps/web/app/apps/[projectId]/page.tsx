"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { api, type AppDetail } from "../../lib/api";
import { buildAppResourceDisplay } from "../../lib/resourceDisplay";
import { deriveRequiredProviders, missingProviders } from "../../lib/planRequirements";
import { runModeLabel, runStatusLabel } from "../../lib/runLabels";
import { buttonStyle, card, colors, h2, mono } from "../../lib/theme";
import { CurrentState } from "../../components/CurrentState";
import { ProviderRequirements } from "../../components/ProviderRequirements";
import { VerificationChecklist } from "../../components/VerificationChecklist";
import { ProjectEnvPanel } from "../../components/ProjectEnvPanel";

const STATUS_COLOR: Record<string, string> = {
  succeeded: colors.success,
  diagnosed: colors.warn,
  failed: colors.error,
  queued: colors.dim,
  analyzing: colors.accentText,
  planning: colors.accentText,
  provisioning: colors.accentText,
  deploying: colors.accentText,
  verifying: colors.accentText,
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
  const [redeploying, setRedeploying] = useState(false);
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

  // Light polling while a deploy is in progress.
  useEffect(() => {
    const latest = detail?.history[0];
    if (!latest) return;
    const active = !["succeeded", "diagnosed", "failed"].includes(latest.status);
    if (!active) return;
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [detail?.history, load]);

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
  const latestRun = detail?.history[0];
  const latestRunNeedsDeployAction =
    latestRun?.mode === "deploy" &&
    (latestRun.status === "failed" || latestRun.status === "diagnosed");
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

  const redeployLatest = async () => {
    setErr(null);
    setRedeploying(true);
    try {
      const { runId } = await api.redeployLatest(projectId);
      router.push(`/runs/${runId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRedeploying(false);
    }
  };

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "2.5rem 1.5rem 6rem" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: "1rem", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 560px" }}>
          <Link href="/" style={{ color: colors.dim, textDecoration: "none", fontSize: "0.84rem" }}>
            Back to My Apps
          </Link>
          <h1 style={{ fontSize: "1.65rem", margin: "0.75rem 0 0", fontFamily: mono, letterSpacing: 0, wordBreak: "break-word" }}>
            {detail?.project.repoFullName ?? "App"}
          </h1>
          <p style={{ margin: "0.4rem 0 0", color: colors.dim, lineHeight: 1.55 }}>
            {display?.fullStack.live
              ? "Showing the latest verified live deployment."
              : action
                ? "Plan is ready, but the app is not verified live yet."
                : "Deployment state and history for this repository."}
          </p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => void redeployLatest()}
            disabled={redeploying}
            style={buttonStyle("primary", redeploying)}
          >
            {redeploying ? "Starting..." : "Redeploy latest"}
          </button>
          <Link href="/new" style={{ textDecoration: "none" }}>
            <button style={buttonStyle("ghost")}>New deployment</button>
          </Link>
        </div>
      </div>

      {err && <div style={{ ...card, borderColor: colors.errorBorder, background: colors.errorBg, color: colors.errorText }}>{err}</div>}

      {latestRun && (
        <section style={{ ...card, margin: "1rem 0", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 360px" }}>
            <h2 style={h2}>Latest run</h2>
            <p style={{ margin: "0.4rem 0 0", color: colors.muted }}>
              {runStatusLabel(latestRun.mode, latestRun.status)} - {runModeLabel(latestRun.mode)}
            </p>
          </div>
          <span
            style={{
              fontSize: "0.74rem",
              fontWeight: 800,
              color: "#061014",
              background: STATUS_COLOR[latestRun.status] ?? colors.dim,
              padding: "0.22rem 0.65rem",
              borderRadius: 999,
            }}
          >
            {runStatusLabel(latestRun.mode, latestRun.status)}
          </span>
        </section>
      )}

      {showDeployAction && action && (
        <section style={{ ...card, margin: "1rem 0 1.5rem", borderColor: colors.warnBorder, background: colors.warnBg }}>
          <p style={{ color: colors.warnText, fontWeight: 800, margin: 0 }}>
            {latestRunNeedsDeployAction
              ? "Latest deploy needs attention. Previous live links are preserved below."
              : "Plan ready, but the app is not deployed yet."}
          </p>
          <p style={{ color: colors.warnText, opacity: 0.92, margin: "0.45rem 0 0.9rem", lineHeight: 1.55 }}>
            Retry this validated plan at the same commit, or use Redeploy latest to pull the tip of{" "}
            <code style={{ fontFamily: mono }}>{detail?.project.defaultBranch ?? "main"}</code>.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => void startDeploy()} disabled={starting} style={buttonStyle("ghost", starting)}>
              {starting ? "Starting..." : action.label}
            </button>
            <button onClick={() => void redeployLatest()} disabled={redeploying} style={buttonStyle("primary", redeploying)}>
              {redeploying ? "Starting..." : "Redeploy latest"}
            </button>
          </div>
          {showConnect && (
            <ProviderRequirements plan={action.plan} connected={connected} onConnected={() => void load()} />
          )}
        </section>
      )}

      {display && (
        <div style={{ marginBottom: "2rem" }}>
          {detail?.latestLiveDeployment && detail.current?.runId !== detail.latestLiveDeployment.runId && (
            <p style={{ color: colors.warn, fontSize: "0.88rem", marginTop: 0, lineHeight: 1.55 }}>
              Latest run is {runStatusLabel(latestRun?.mode ?? "", latestRun?.status ?? "")}. Showing the most recent verified live deployment links below.
            </p>
          )}
          <CurrentState display={display} />
          {visibleDeployment.verification.length > 0 && (
            <section style={{ ...card, marginTop: "1rem" }}>
              <VerificationChecklist
                verification={visibleDeployment.verification}
                plan={action?.plan ?? null}
              />
            </section>
          )}
        </div>
      )}

      <ProjectEnvPanel projectId={projectId} />

      <section>
        <h2 style={h2}>Deployment history</h2>
        {detail?.history.length === 0 && <p style={{ color: colors.dim }}>No runs yet.</p>}
        <div style={{ marginTop: "0.75rem" }}>
          {detail?.history.map((r) => (
            <Link key={r.id} href={`/runs/${r.id}`} style={{ textDecoration: "none", color: "inherit" }}>
              <div
                style={{
                  background: colors.card,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  padding: "1rem",
                  marginBottom: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  cursor: "pointer",
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontSize: "0.72rem",
                    fontWeight: 800,
                    color: "#061014",
                    background: STATUS_COLOR[r.status] ?? colors.dim,
                    padding: "0.14rem 0.55rem",
                    borderRadius: 999,
                    minWidth: 120,
                    textAlign: "center",
                  }}
                >
                  {runStatusLabel(r.mode, r.status)}
                </span>
                <span style={{ color: colors.muted, fontSize: "0.85rem" }}>{runModeLabel(r.mode)}</span>
                <span style={{ color: colors.dim, fontSize: "0.8rem", fontFamily: mono }}>{r.commitSha.slice(0, 8)}</span>
                <span style={{ marginLeft: "auto", color: colors.dim, fontSize: "0.8rem" }}>
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
