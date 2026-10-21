"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { deriveRequiredProviders, missingProviders } from "../../lib/planRequirements";
import { runModeLabel, runStatusLabel } from "../../lib/runLabels";
import { useRun } from "../../lib/useRun";
import { colors, mono } from "../../lib/theme";
import { ActivityStages } from "../../components/ActivityStages";
import { FailureGuidance, extractFailureGuidance } from "../../components/FailureGuidance";
import { LogDrawer } from "../../components/LogDrawer";
import { OutcomeBanner } from "../../components/OutcomeBanner";
import { EscapeHatch, escapeFrom } from "../../components/EscapeHatch";
import { LaunchReadiness, readinessFrom } from "../../components/LaunchReadiness";
import { companionsFrom, PlanPanel } from "../../components/PlanPanel";
import { ProviderCredentialFix, providersNeedingCredentialFix } from "../../components/ProviderCredentialFix";
import { ProviderRequirements } from "../../components/ProviderRequirements";
import { WorkerStalledNotice } from "../../components/WorkerStalledNotice";
import { ControlPlaneConsistencyNotice } from "../../components/ControlPlaneConsistencyNotice";
import { AppNav, Badge, Button, PageHeader, Panel, Shell, Skeleton, Tabs } from "../../components/ui";

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
  const [tab, setTab] = useState("overview");

  const refreshProviders = useCallback(async () => {
    try {
      const providers = await api.listProviders();
      setConnected(providers.connected);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const required = deriveRequiredProviders(run.plan);
  const missing = missingProviders(required, connected);
  const failureGuidance = extractFailureGuidance(run.events);
  const credentialFixProviders = providersNeedingCredentialFix(run.events);
  const needsCredentialFix =
    failureGuidance?.action === "update_credentials" ||
    failureGuidance?.action === "fix_account_setup" ||
    credentialFixProviders.length > 0;
  const terminal = ["succeeded", "diagnosed", "failed"].includes(snap?.run.status ?? run.status);
  const isPlanReady = snap?.run.mode === "plan" && snap.run.status === "succeeded";
  const canRetryDeploy = snap?.run.mode === "deploy" && ["failed", "diagnosed"].includes(snap.run.status);
  const hasLiveDeployment = Boolean(snap?.layers.fullStack.live || snap?.resources.some((r) => r.status === "live"));
  const primaryLabel = isPlanReady && !hasLiveDeployment ? "Deploy this plan" : canRetryDeploy ? "Retry deploy" : null;
  const pageTitle = runPageTitle(snap?.run.mode, snap?.run.status ?? run.status, Boolean(snap?.layers.fullStack.live));
  const status = snap?.run.status ?? run.status;

  const startDeployFromThisRun = async () => {
    if (!snap) return;
    setActionError(null);
    const providers = await api.listProviders().catch(() => ({ connected }));
    setConnected(providers.connected);
    if (missingProviders(deriveRequiredProviders(run.plan), providers.connected).length > 0) {
      setShowConnect(true);
      setTab("overview");
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

  const statusBadgeTone =
    hasLiveDeployment || status === "succeeded"
      ? "success"
      : status === "failed"
        ? "error"
        : status === "diagnosed"
          ? "warn"
          : "info";

  return (
    <Shell>
      <AppNav
        right={
          <Link href="/new" style={{ textDecoration: "none" }}>
            <Button variant="ghost">New deployment</Button>
          </Link>
        }
      />

      <PageHeader
        eyebrow={
          <Link
            href={snap?.run.projectId ? `/apps/${snap.run.projectId}` : "/"}
            style={{ color: colors.dim, textDecoration: "none", fontSize: "0.82rem" }}
          >
            {snap?.run.projectId ? "Back to app" : "Back to apps"}
          </Link>
        }
        title={pageTitle}
        subtitle={
          snap?.run.repoFullName ? (
            <span style={{ fontFamily: mono, fontSize: "0.84rem" }}>
              {snap.run.repoFullName}
              {snap.run.commitSha ? ` · ${snap.run.commitSha.slice(0, 8)}` : ""}
              {" · "}
              {runModeLabel(snap.run.mode)}
            </span>
          ) : undefined
        }
        actions={<Badge tone={statusBadgeTone}>{runStatusLabel(snap?.run.mode ?? "", status)}</Badge>}
      />

      {run.status === "loading" && (
        <div style={{ display: "grid", gap: 10 }}>
          <Skeleton height={72} />
          <Skeleton height={160} />
        </div>
      )}
      {run.error && (
        <Panel style={{ borderColor: colors.errorBorder, color: colors.errorText, marginBottom: "1rem" }}>
          {run.error}
        </Panel>
      )}
      {actionError && (
        <Panel style={{ borderColor: colors.errorBorder, background: colors.errorBg, marginBottom: "1rem" }}>
          <p style={{ margin: 0, color: colors.errorText }}>Could not start deploy from this plan.</p>
          <Button variant="ghost" onClick={() => setShowTechnicalError((v) => !v)} style={{ marginTop: 8 }}>
            {showTechnicalError ? "Hide details" : "Show details"}
          </Button>
          {showTechnicalError && (
            <pre style={{ whiteSpace: "pre-wrap", color: colors.errorText, fontSize: "0.78rem", marginTop: 8 }}>{actionError}</pre>
          )}
        </Panel>
      )}

      {primaryLabel && (
        <Panel style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: "1.25rem" }}>
          <div style={{ flex: "1 1 320px" }}>
            <strong style={{ fontWeight: 600 }}>
              {needsCredentialFix
                ? "Update the failing provider, then retry."
                : isPlanReady
                  ? "This plan is ready to deploy."
                  : "This deploy can be retried."}
            </strong>
            <p style={{ margin: "0.3rem 0 0", color: colors.dim, fontSize: "0.84rem", lineHeight: 1.5 }}>
              {needsCredentialFix
                ? `Only ${(credentialFixProviders.length > 0 ? credentialFixProviders : [failureGuidance?.provider ?? "provider"]).join(", ")} needs attention.`
                : missing.length > 0
                  ? "Connect missing providers first."
                  : "Reuses this plan and re-runs provider checks."}
            </p>
          </div>
          <Button onClick={() => void startDeployFromThisRun()} disabled={starting}>
            {starting ? "Starting…" : primaryLabel}
          </Button>
          {(missing.length > 0 || needsCredentialFix) && (
            <Button
              variant="ghost"
              onClick={() => {
                setShowConnect(true);
                setTab("overview");
              }}
            >
              {needsCredentialFix ? "Update credentials" : "Fix providers"}
            </Button>
          )}
        </Panel>
      )}

      <WorkerStalledNotice show={run.workerStalled && !run.controlPlaneMismatch} />
      <ControlPlaneConsistencyNotice show={run.controlPlaneMismatch} />

      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "plan", label: "Plan" },
          { id: "activity", label: "Activity" },
          { id: "logs", label: "Logs" },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "overview" && (
        <div className="sf-fade-in">
          {needsCredentialFix && terminal && (
            <ProviderCredentialFix
              events={run.events}
              plan={run.plan}
              connected={connected}
              onUpdated={refreshProviders}
              onRetryDeploy={() => void startDeployFromThisRun()}
              retrying={starting}
            />
          )}
          {showConnect && run.plan && !needsCredentialFix && (
            <ProviderRequirements plan={run.plan} connected={connected} onConnected={refreshProviders} allowUpdate />
          )}
          {status === "awaiting_input" && run.plan && (
            <PlanPanel
              plan={run.plan}
              runId={runId}
              waiting
              answeredQuestionIds={snap?.answeredQuestionIds ?? []}
              onAnswersSaved={() => void run.refreshSnapshot()}
              companions={companionsFrom(run.repoContext)}
            />
          )}
          <EscapeHatch plan={escapeFrom(run.repoContext)} />
          <LaunchReadiness report={readinessFrom(run.repoContext)} />
          <OutcomeBanner status={status} snapshot={snap} />
          <FailureGuidance
            events={run.events}
            onUpdateCredentials={
              needsCredentialFix
                ? () => {
                    setShowConnect(true);
                    setTab("overview");
                  }
                : undefined
            }
          />
        </div>
      )}

      {tab === "plan" && (
        <div className="sf-fade-in">
          <EscapeHatch plan={escapeFrom(run.repoContext)} />
          <LaunchReadiness report={readinessFrom(run.repoContext)} />
          {run.plan ? (
            <PlanPanel
              plan={run.plan}
              runId={runId}
              waiting={status === "awaiting_input"}
              answeredQuestionIds={snap?.answeredQuestionIds ?? []}
              onAnswersSaved={() => void run.refreshSnapshot()}
              companions={companionsFrom(run.repoContext)}
            />
          ) : (
            <Panel>
              <p style={{ margin: 0, color: colors.dim }}>No plan for this run yet.</p>
            </Panel>
          )}
        </div>
      )}

      {tab === "activity" && (
        <div className="sf-fade-in">
          <Panel>
            <ActivityStages status={status} events={run.events} />
          </Panel>
        </div>
      )}

      {tab === "logs" && (
        <div className="sf-fade-in">
          <LogDrawer events={run.events} />
        </div>
      )}

      {snap?.run.projectId && (
        <p style={{ marginTop: "2rem" }}>
          <Link href={`/apps/${snap.run.projectId}`} style={{ color: colors.accentText, fontSize: "0.88rem" }}>
            View all runs for this app
          </Link>
        </p>
      )}
    </Shell>
  );
}

function runPageTitle(mode: string | undefined, status: string, fullStackLive: boolean): string {
  if (fullStackLive) return "Your app is live";
  if (mode === "plan" && status === "succeeded") return "Plan ready";
  if (mode === "plan" && status === "failed") return "Plan failed";
  if (mode === "deploy" && status === "failed") return "Deploy failed";
  if (mode === "deploy" && status === "diagnosed") return "Deploy needs attention";
  if (status === "awaiting_input") return "Waiting for your answer";
  if (mode === "deploy" && status === "succeeded") return "Deploy succeeded";
  if (["queued", "cloning", "analyzing", "planning", "validating", "provisioning", "deploying", "verifying"].includes(status)) {
    return "Deployment in progress";
  }
  return mode === "plan" ? "Deployment plan" : "Deployment run";
}
