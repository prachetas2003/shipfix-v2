"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, type PlanView, type RunEventRow } from "../lib/api";
import { deriveRequiredProviders, missingProviders } from "../lib/planRequirements";
import { useRun } from "../lib/useRun";
import { colors, inputStyle, mono } from "../lib/theme";
import { WorkerStalledNotice } from "../components/WorkerStalledNotice";
import { ControlPlaneConsistencyNotice } from "../components/ControlPlaneConsistencyNotice";
import { FixGuidance } from "../components/FixGuidance";
import { GithubConnect } from "../components/GithubConnect";
import { RepoPicker } from "../components/RepoPicker";
import { OutcomeBanner } from "../components/OutcomeBanner";
import { EscapeHatch, escapeFrom } from "../components/EscapeHatch";
import { LaunchReadiness, readinessFrom } from "../components/LaunchReadiness";
import { companionsFrom, PlanPanel } from "../components/PlanPanel";
import { ProviderCredentialFix } from "../components/ProviderCredentialFix";
import { ProviderRequirements } from "../components/ProviderRequirements";
import { Stepper } from "../components/Stepper";
import { Timeline } from "../components/Timeline";
import { AppNav, Button, PageHeader, Panel, Shell, Skeleton } from "../components/ui";

const STEPS = ["Repository", "Plan", "Connect", "Deploy", "Result"];

function planFailureMessage(events: RunEventRow[]): string {
  const lastFailure = [...events].reverse().find((ev) => {
    const event = typeof ev.data?.event === "string" ? ev.data.event : "";
    return ["usage_limit_reached", "llm_unavailable", "llm_config_missing", "planning_failed", "run_failed"].includes(event);
  });
  const event = typeof lastFailure?.data?.event === "string" ? lastFailure.data.event : "";
  const message = typeof lastFailure?.data?.message === "string" ? lastFailure.data.message : "";
  if (event === "usage_limit_reached") return message || "This account has reached its usage limit. Try again later.";
  if (event === "llm_unavailable") {
    return "The AI planner is temporarily unavailable (the model provider is overloaded or unreachable). This is not a usage limit — wait a minute and analyze again.";
  }
  if (event === "llm_config_missing") {
    return message || "Planner setup is missing. Add backend-only LLM env vars to the worker, restart the worker, then try again.";
  }
  return "ShipFix could not produce a plan for this repo. Open the timeline details below for the technical error, then try again.";
}

export default function NewDeploymentPage(): React.ReactElement {
  const [step, setStep] = useState(0);
  const [repo, setRepo] = useState("");
  const [planRunId, setPlanRunId] = useState<string | null>(null);
  const [deployRunId, setDeployRunId] = useState<string | null>(null);
  const [capturedPlan, setCapturedPlan] = useState<PlanView | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const [oauthProviders, setOauthProviders] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const activeRunId = deployRunId ?? planRunId;
  const run = useRun(activeRunId);

  useEffect(() => {
    if (run.plan) setCapturedPlan(run.plan);
  }, [run.plan]);

  const refreshProviders = useCallback(async () => {
    try {
      const [p, oauth] = await Promise.all([
        api.listProviders(),
        api.listOauthProviders().catch(() => ({ providers: [] as string[] })),
      ]);
      setConnected(p.connected);
      setOauthProviders(oauth.providers);
    } catch {
      /* non-fatal */
    }
  }, []);
  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  useEffect(() => {
    if (step === 1 && capturedPlan) setStep(2);
  }, [step, capturedPlan]);

  useEffect(() => {
    if (step === 3 && deployRunId && ["succeeded", "diagnosed", "failed"].includes(run.status)) {
      setStep(4);
    }
  }, [step, deployRunId, run.status]);

  const startPlan = async (repoName = repo) => {
    const target = repoName.trim();
    if (!target) return;
    setRepo(target);
    setStarting(true);
    setErr(null);
    setCapturedPlan(null);
    setDeployRunId(null);
    try {
      const id = await api.startRun("plan", target);
      setPlanRunId(id);
      setStep(1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const startDeploy = async () => {
    const sourceRunId = deployRunId ?? planRunId;
    if (!sourceRunId) return;
    setStarting(true);
    setErr(null);
    try {
      const id = await api.startDeployFromRun(sourceRunId);
      setDeployRunId(id);
      setStep(3);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const required = deriveRequiredProviders(capturedPlan);
  const missing = missingProviders(required, connected);
  const classification = capturedPlan?.classification;
  const allConnected = missing.length === 0;
  const canDeploy = allConnected && classification === "deployable";
  const showRecheck = allConnected && classification !== "deployable";
  const deployDisabledReason = !allConnected
    ? "Connect the required providers first"
    : classification !== "deployable"
      ? "The plan is not deployable yet — resolve the setup items and re-check"
      : "Provision, deploy, and verify";

  return (
    <Shell>
      <AppNav
        right={
          <Link href="/" style={{ textDecoration: "none" }}>
            <Button variant="ghost">Apps</Button>
          </Link>
        }
      />

      <PageHeader
        title="New deployment"
        subtitle="Pick a repo or paste one, then connect only the hosts this app needs."
      />

      <Stepper steps={STEPS} current={step} />

      {err && (
        <Panel style={{ borderColor: colors.errorBorder, background: colors.errorBg, color: colors.errorText, marginBottom: "1rem" }}>
          {err}
        </Panel>
      )}

      {step === 0 && (
        <Panel className="sf-slide-up">
          <h2 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 600 }}>Repository</h2>
          <p style={{ color: colors.dim, fontSize: "0.9rem", lineHeight: 1.6, margin: "0.45rem 0 0" }}>
            Vite, Next.js, TanStack Start and other server-rendered apps on Vercel; Node, Python (FastAPI, Flask, Streamlit) and Dockerfile services on Render; Postgres on Neon, Redis on Upstash. Other stacks get an honest diagnosis.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: "1rem" }}>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && repo.trim() && !starting) void startPlan();
              }}
              placeholder="owner/repo or https://github.com/owner/repo"
              spellCheck={false}
              style={{ ...inputStyle, flex: 1, minWidth: 280, fontFamily: mono }}
            />
            <Button onClick={() => void startPlan()} disabled={starting || repo.trim().length === 0}>
              {starting ? "Analyzing…" : "Analyze repo"}
            </Button>
          </div>
          <RepoPicker disabled={starting} onPick={(fullName) => void startPlan(fullName)} />
          <GithubConnect />
        </Panel>
      )}

      {step === 1 && (
        <section className="sf-fade-in">
          <Panel style={{ background: colors.panelSoft, marginBottom: "0.85rem" }}>
            <strong style={{ fontWeight: 600 }}>Building your deployment plan</strong>
            <p style={{ margin: "0.4rem 0 0", color: colors.dim, lineHeight: 1.55, fontSize: "0.9rem" }}>
              Reading <code style={{ fontFamily: mono }}>{repo}</code>, identifying services, and checking whether ShipFix can deploy them safely.
            </p>
            {!capturedPlan && run.status !== "failed" && (
              <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                <Skeleton height={12} />
                <Skeleton height={12} width="70%" />
              </div>
            )}
          </Panel>
          <WorkerStalledNotice show={run.workerStalled && !run.controlPlaneMismatch} />
          <ControlPlaneConsistencyNotice show={run.controlPlaneMismatch} />
          <Timeline events={run.events} />
          {run.status === "failed" && !capturedPlan && (
            <Panel style={{ borderColor: colors.errorBorder, background: colors.errorBg, color: colors.errorText, marginTop: "1rem" }}>
              <p style={{ margin: 0 }}>{planFailureMessage(run.events)}</p>
              <div style={{ marginTop: 12 }}>
                <Button variant="ghost" onClick={() => setStep(0)}>
                  Back to repository
                </Button>
              </div>
            </Panel>
          )}
        </section>
      )}

      {step === 2 && capturedPlan && (
        <section className="sf-fade-in">
          <EscapeHatch plan={escapeFrom(run.repoContext)} />
          <LaunchReadiness report={readinessFrom(run.repoContext)} />
          <PlanPanel
            plan={capturedPlan}
            runId={planRunId ?? undefined}
            answeredQuestionIds={run.snapshot?.answeredQuestionIds ?? []}
            onAnswersSaved={() => void run.refreshSnapshot()}
            onPlanRevalidated={(p) => setCapturedPlan(p)}
            companions={companionsFrom(run.repoContext)}
          />
          <ProviderRequirements
            plan={capturedPlan}
            connected={connected}
            onConnected={refreshProviders}
            allowUpdate
            oauthProviders={oauthProviders}
          />
          <div style={{ display: "flex", gap: 10, marginTop: "1.25rem", flexWrap: "wrap" }}>
            <Button
              variant="success"
              onClick={() => void startDeploy()}
              disabled={!canDeploy || starting}
              title={deployDisabledReason}
            >
              {starting ? "Starting deploy…" : "Deploy this plan"}
            </Button>
            {showRecheck && (
              <Button variant="ghost" onClick={() => void startPlan()} disabled={starting}>
                {starting ? "Re-checking…" : "Re-check plan"}
              </Button>
            )}
            <Button variant="ghost" onClick={() => void refreshProviders()}>
              Refresh connections
            </Button>
          </div>
          {!allConnected ? (
            <p style={{ marginTop: "0.65rem", fontSize: "0.86rem", color: colors.warn }}>
              Connect {missing.map((m) => m.provider).join(", ")} above to enable deploy.
            </p>
          ) : classification === "diagnose_only" ? (
            <p style={{ marginTop: "0.65rem", fontSize: "0.86rem", color: colors.warn, lineHeight: 1.55 }}>
              Deploy is disabled: this app is outside what ShipFix can auto-deploy. Use the diagnosis above, or re-check after connecting providers.
            </p>
          ) : classification === "needs_setup" ? (
            <p style={{ marginTop: "0.65rem", fontSize: "0.86rem", color: colors.warn, lineHeight: 1.55 }}>
              Deploy is disabled until setup items above are resolved. Re-check the plan after addressing them.
            </p>
          ) : null}
        </section>
      )}

      {step === 3 && (
        <section className="sf-fade-in">
          <Panel style={{ background: colors.panelSoft, marginBottom: "0.85rem" }}>
            <strong style={{ fontWeight: 600 }}>Deploying and verifying</strong>
            <p style={{ margin: "0.4rem 0 0", color: colors.dim, lineHeight: 1.55, fontSize: "0.9rem" }}>
              Provisioning the database, deploying services, wiring env vars, and verifying the live system.
            </p>
            <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
              <Skeleton height={12} />
              <Skeleton height={12} width="55%" />
            </div>
          </Panel>
          <WorkerStalledNotice show={run.workerStalled && !run.controlPlaneMismatch} />
          <ControlPlaneConsistencyNotice show={run.controlPlaneMismatch} />
          <Timeline events={run.events} />
          {deployRunId && (
            <div style={{ marginTop: "1rem" }}>
              <Link href={`/runs/${deployRunId}`} style={{ textDecoration: "none" }}>
                <Button variant="ghost">Open full run details</Button>
              </Link>
            </div>
          )}
        </section>
      )}

      {step === 4 && (
        <section className="sf-fade-in">
          <OutcomeBanner status={run.status} snapshot={run.snapshot} />
          <ProviderCredentialFix
            events={run.events}
            plan={capturedPlan}
            connected={connected}
            onUpdated={() => void refreshProviders()}
            onRetryDeploy={() => void startDeploy()}
            retrying={starting}
          />
          <FixGuidance events={run.events} />
          <Timeline events={run.events} />
          <div style={{ display: "flex", gap: 10, marginTop: "1.25rem", flexWrap: "wrap" }}>
            {run.snapshot?.run.projectId && (
              <Link href={`/apps/${run.snapshot.run.projectId}`} style={{ textDecoration: "none" }}>
                <Button>View app details</Button>
              </Link>
            )}
            {(run.status === "diagnosed" || run.status === "failed") && (
              <Button variant="ghost" onClick={() => void startDeploy()} disabled={starting}>
                {starting ? "Retrying…" : "Retry deploy"}
              </Button>
            )}
            <Link href="/" style={{ textDecoration: "none" }}>
              <Button variant="ghost">Back to apps</Button>
            </Link>
          </div>
        </section>
      )}
    </Shell>
  );
}
