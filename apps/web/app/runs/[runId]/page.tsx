"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { deriveRequiredProviders, missingProviders } from "../../lib/planRequirements";
import { runModeLabel, runStatusLabel } from "../../lib/runLabels";
import { useRun } from "../../lib/useRun";
import { buttonStyle, card, colors, mono } from "../../lib/theme";
import { FixGuidance } from "../../components/FixGuidance";
import { OutcomeBanner } from "../../components/OutcomeBanner";
import { PlanPanel } from "../../components/PlanPanel";
import { ProviderRequirements } from "../../components/ProviderRequirements";
import { Timeline } from "../../components/Timeline";
import { WorkerStalledNotice } from "../../components/WorkerStalledNotice";
import { ControlPlaneConsistencyNotice } from "../../components/ControlPlaneConsistencyNotice";

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
  const pageTitle = runPageTitle(snap?.run.mode, snap?.run.status ?? run.status, Boolean(snap?.layers.fullStack.live));

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
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "2.5rem 1.5rem 6rem" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: "1rem", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 520px" }}>
          <Link href="/" style={{ color: colors.dim, textDecoration: "none", fontSize: "0.84rem" }}>
            Back to My Apps
          </Link>
          <h1 style={{ fontSize: "1.75rem", margin: "0.75rem 0 0", letterSpacing: 0 }}>{pageTitle}</h1>
          {snap?.run.repoFullName && (
            <p style={{ color: colors.dim, fontFamily: mono, fontSize: "0.88rem", margin: "0.4rem 0 0" }}>
              {snap.run.repoFullName} / {runModeLabel(snap.run.mode)} /{" "}
              <strong style={{ color: colors.text }}>{runStatusLabel(snap.run.mode, snap.run.status)}</strong>
            </p>
          )}
        </div>
        <Link href="/new" style={{ marginLeft: "auto", textDecoration: "none" }}>
          <button style={buttonStyle("ghost")}>Start different deployment</button>
        </Link>
      </div>

      {run.status === "loading" && <p style={{ color: colors.dim }}>Loading run...</p>}
      {run.error && <p style={{ color: colors.error }}>{run.error}</p>}
      {actionError && (
        <div style={{ ...card, borderColor: colors.errorBorder, background: colors.errorBg, color: colors.errorText, marginBottom: "1rem" }}>
          <p style={{ margin: 0 }}>Could not start deploy from this plan. Please retry.</p>
          <button
            onClick={() => setShowTechnicalError((v) => !v)}
            style={{ ...buttonStyle("ghost"), marginTop: 8 }}
          >
            {showTechnicalError ? "Hide technical details" : "Show technical details"}
          </button>
          {showTechnicalError && (
            <pre style={{ whiteSpace: "pre-wrap", color: colors.errorText, fontSize: "0.8rem" }}>{actionError}</pre>
          )}
        </div>
      )}

      {primaryLabel && (
        <section style={{ ...card, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", margin: "1rem 0" }}>
          <div style={{ flex: "1 1 360px" }}>
            <strong>{isPlanReady ? "This plan is ready to deploy." : "This deploy can be retried."}</strong>
            <p style={{ margin: "0.35rem 0 0", color: colors.dim, fontSize: "0.86rem" }}>
              {missing.length > 0
                ? "Connect the missing providers first, then ShipFix can continue from this plan."
                : "ShipFix will reuse the selected plan and run the provider checks again."}
            </p>
          </div>
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

      <WorkerStalledNotice show={run.workerStalled && !run.controlPlaneMismatch} />
      <ControlPlaneConsistencyNotice show={run.controlPlaneMismatch} />
      <OutcomeBanner status={snap?.run.status ?? run.status} snapshot={snap} />
      <FixGuidance events={run.events} />
      {run.plan && (
        <PlanPanel
          plan={run.plan}
          runId={runId}
          answeredQuestionIds={snap?.answeredQuestionIds ?? []}
          onAnswersSaved={() => void run.refreshSnapshot()}
        />
      )}
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

function runPageTitle(mode: string | undefined, status: string, fullStackLive: boolean): string {
  if (fullStackLive) return "Your app is live";
  if (mode === "plan" && status === "succeeded") return "Plan ready";
  if (mode === "plan" && status === "failed") return "Plan failed";
  if (mode === "deploy" && status === "failed") return "Deploy failed";
  if (mode === "deploy" && status === "diagnosed") return "Deploy needs attention";
  if (mode === "deploy" && status === "succeeded") return "Deploy succeeded";
  if (["queued", "cloning", "analyzing", "planning", "validating", "provisioning", "deploying", "verifying"].includes(status)) {
    return "Deployment in progress";
  }
  return mode === "plan" ? "Deployment plan" : "Deployment run";
}
