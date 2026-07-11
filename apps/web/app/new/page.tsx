"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, type PlanView, type RunEventRow } from "../lib/api";
import { deriveRequiredProviders, missingProviders } from "../lib/planRequirements";
import { useRun } from "../lib/useRun";
import { colors, inputStyle, mono } from "../lib/theme";
import { WorkerStalledNotice } from "../components/WorkerStalledNotice";
import { ControlPlaneConsistencyNotice } from "../components/ControlPlaneConsistencyNotice";
import { FixGuidance } from "../components/FixGuidance";
import { OutcomeBanner } from "../components/OutcomeBanner";
import { PlanPanel } from "../components/PlanPanel";
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
  if (event === "usage_limit_reached") return message || "Usage limit reached. Try again later, or raise local alpha limits while testing.";
  if (event === "llm_unavailable") {
    return "The AI planner is temporarily unavailable (the model provider is overloaded or unreachable). This is not a usage limit — wait a minute and analyze again.";
  }
  if (event === "llm_config_missing") {
    return message || "Planner setup is missing. Add backend-only LLM env vars to the worker, restart the worker, then try again.";
  }
  return "ShipFix could not produce a plan for this repo. Open the timeline details below for the technical error, then try again.";
}

export default function NewDeploymentPage(): React.ReactElement {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [repo, setRepo] = useState("");
  const [planRunId, setPlanRunId] = useState<string | null>(null);
  const [deployRunId, setDeployRunId] = useState<string | null>(null);
  const [capturedPlan, setCapturedPlan] = useState<PlanView | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const activeRunId = deployRunId ?? planRunId;
  const run = useRun(activeRunId);

  useEffect(() => {
    if (run.plan) setCapturedPlan(run.plan);
  }, [run.plan]);

  const refreshProviders = useCallback(async () => {
    try {
      const p = await api.listProviders();
      setConnected(p.connected);
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

  const startPlan = async () => {
    setStarting(true);
    setErr(null);
    setCapturedPlan(null);
    setDeployRunId(null);
    try {
      const id = await api.startRun("plan", repo);
      setPlanRunId(id);
      setStep(1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const startDeploy = async () => {
    setStarting(true);
    setErr(null);
    try {
      const id = await api.startRun("deploy", repo);
      setDeployRunId(id);
      setStep(3);
      router.push(`/runs/${id}`);
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
        subtitle="Paste a repo → analyze → connect only what’s missing → deploy and verify."
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
            Vite and Next.js frontends on Vercel, Node APIs on Render, Postgres on Neon. Other stacks get an honest diagnosis.
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
          <PlanPanel
            plan={capturedPlan}
            runId={planRunId ?? undefined}
            answeredQuestionIds={run.snapshot?.answeredQuestionIds ?? []}
            onAnswersSaved={() => void run.refreshSnapshot()}
            onPlanRevalidated={(p) => setCapturedPlan(p)}
          />
          <ProviderRequirements plan={capturedPlan} connected={connected} onConnected={refreshProviders} allowUpdate />
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
        </section>
      )}

      {step === 4 && (
        <section className="sf-fade-in">
          <OutcomeBanner status={run.status} snapshot={run.snapshot} />
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
