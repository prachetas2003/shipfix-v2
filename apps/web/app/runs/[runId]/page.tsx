"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { deriveRequiredProviders, missingProviders } from "../../lib/planRequirements";
import { runModeLabel, runStatusLabel } from "../../lib/runLabels";
import { useRun } from "../../lib/useRun";
import { buttonStyle, colors, mono } from "../../lib/theme";
import { FixGuidance } from "../../components/FixGuidance";
import { OutcomeBanner } from "../../components/OutcomeBanner";
import { PlanPanel } from "../../components/PlanPanel";
import { ProviderRequirements } from "../../components/ProviderRequirements";
import { Timeline } from "../../components/Timeline";

export default function RunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}): React.ReactElement {
  const { runId } = use(params);
  const router = useRouter();
  const run = useRun(runId);
  const snap = run.snapshot;
  const [connected, setConnected] = useState<string[]>([]);
  const [showConnect, setShowConnect] = useState(false);
  const [showTechnicalError, setShowTechnicalError] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshProviders = useCallback(async () => {
    try {
      const providers = await api.listProviders();
      setConnected(providers.connected);
    } catch {
      /* non-fatal: deploy API still gates server-side */
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const required = deriveRequiredProviders(run.plan);
  const missing = missingProviders(required, connected);
  const terminal = ["succeeded", "diagnosed", "failed"].includes(snap?.run.status ?? run.status);
  const isPlanReady = snap?.run.mode === "plan" && snap.run.status === "succeeded";
  const canRetryDeploy = snap?.run.mode === "deploy" && ["failed", "diagnosed"].includes(snap.run.status);
  const hasLiveDeployment = Boolean(snap?.layers.fullStack.live || snap?.resources.some((r) => r.status === "live"));
  const primaryLabel = isPlanReady && !hasLiveDeployment ? "Deploy this plan" : canRetryDeploy ? "Retry deploy" : null;

  const startDeployFromThisRun = async () => {
    if (!snap) return;
    setActionError(null);
    const providers = await api.listProviders().catch(() => ({ connected }));
    setConnected(providers.connected);
    if (missingProviders(deriveRequiredProviders(run.plan), providers.connected).length > 0) {
      setShowConnect(true);
      return;
    }
    setStarting(true);
    try {
      const deployRunId = await api.startDeployFromRun(snap.run.id);
      router.push(`/runs/${deployRunId}`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
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
        <h1 style={{ fontSize: "1.4rem", margin: 0 }}>
          {snap?.run.mode === "plan" ? "Deployment plan" : "Deployment run"}
        </h1>
        <Link href="/new" style={{ marginLeft: "auto", textDecoration: "none" }}>
          <button style={buttonStyle("ghost")}>Start new deployment</button>
        </Link>
      </div>

      {snap?.run.repoFullName && (
        <p style={{ opacity: 0.7, fontFamily: mono, fontSize: "0.9rem" }}>
          {snap.run.repoFullName} | {runModeLabel(snap.run.mode)} |{" "}
          <strong>{runStatusLabel(snap.run.mode, snap.run.status)}</strong>
        </p>
      )}
      {run.status === "loading" && <p style={{ opacity: 0.6 }}>Loading run...</p>}
      {run.error && <p style={{ color: colors.error }}>{run.error}</p>}
      {actionError && (
        <div style={{ color: colors.error, marginBottom: "1rem" }}>
          <p style={{ margin: 0 }}>Could not start deploy from plan. Please retry.</p>
          <button
            onClick={() => setShowTechnicalError((v) => !v)}
            style={{ ...buttonStyle("ghost"), marginTop: 8 }}
          >
            {showTechnicalError ? "Hide technical details" : "Show technical details"}
          </button>
          {showTechnicalError && (
            <pre style={{ whiteSpace: "pre-wrap", opacity: 0.75, fontSize: "0.8rem" }}>{actionError}</pre>
          )}
        </div>
      )}

      {primaryLabel && (
        <section style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "1rem 0" }}>
          <button onClick={() => void startDeployFromThisRun()} disabled={starting} style={buttonStyle("primary", starting)}>
            {starting ? "Starting deployment from this plan..." : primaryLabel}
          </button>
          {missing.length > 0 && (
            <button onClick={() => setShowConnect((v) => !v)} style={buttonStyle("ghost")}>
              Fix provider setup
            </button>
          )}
        </section>
      )}

      {showConnect && run.plan && (
        <ProviderRequirements plan={run.plan} connected={connected} onConnected={refreshProviders} />
      )}

      <OutcomeBanner status={snap?.run.status ?? run.status} snapshot={snap} />
      <FixGuidance events={run.events} />
      {run.plan && <PlanPanel plan={run.plan} />}
      <Timeline events={run.events} />

      {snap?.run.projectId && (
        <p style={{ marginTop: "2rem" }}>
          <Link href={`/apps/${snap.run.projectId}`} style={{ color: colors.accentText }}>
            View all runs for this app
          </Link>
        </p>
      )}

      {terminal && (
        <p style={{ marginTop: "1rem" }}>
          <Link href="/new" style={{ color: colors.dim }}>
            Start a different deployment
          </Link>
        </p>
      )}
    </main>
  );
}
