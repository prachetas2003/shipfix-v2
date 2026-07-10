"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, type PlanView, type RunEventRow } from "../lib/api";
import { deriveRequiredProviders, missingProviders } from "../lib/planRequirements";
import { useRun } from "../lib/useRun";
import { WorkerStalledNotice } from "../components/WorkerStalledNotice";
import { ControlPlaneConsistencyNotice } from "../components/ControlPlaneConsistencyNotice";
import { buttonStyle, card, colors, inputStyle, mono } from "../lib/theme";
import { BrandMark } from "../components/BrandMark";
import { FixGuidance } from "../components/FixGuidance";
import { OutcomeBanner } from "../components/OutcomeBanner";
import { PlanPanel } from "../components/PlanPanel";
import { ProviderRequirements } from "../components/ProviderRequirements";
import { Stepper } from "../components/Stepper";
import { Timeline } from "../components/Timeline";

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
  // Raw planner/worker errors stay in the technical timeline details; this
  // banner stays user-readable.
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
  // Mirror the server's deploy gate: only GREEN plans can deploy. Offering the
  // button on YELLOW/RED plans would just produce a "diagnosed" run.
  const canDeploy = allConnected && classification === "deployable";
  const showRecheck = allConnected && classification !== "deployable";
  const deployDisabledReason = !allConnected
    ? "Connect the required providers first"
    : classification !== "deployable"
      ? "The plan is not deployable yet — resolve the setup items and re-check"
      : "Provision, deploy, and verify";

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "2.5rem 1.5rem 6rem" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: "1.5rem", flexWrap: "wrap" }}>
        <div>
          <Link href="/" style={{ color: colors.dim, textDecoration: "none", fontSize: "0.84rem" }}>
            Back to My Apps
          </Link>
          <div style={{ marginTop: "0.75rem" }}>
            <BrandMark size={32} />
          </div>
          <h1 style={{ fontSize: "1.9rem", margin: "0.9rem 0 0", letterSpacing: 0 }}>New deployment</h1>
          <p style={{ margin: "0.45rem 0 0", color: colors.dim, maxWidth: 680, lineHeight: 1.6 }}>
            Start with a GitHub repo. ShipFix will plan first, ask for only the needed providers, then deploy and verify the live app.
          </p>
        </div>
      </div>

      <Stepper steps={STEPS} current={step} />

      {err && (
        <div style={{ ...card, borderColor: colors.errorBorder, background: colors.errorBg, color: colors.errorText, marginBottom: "1rem" }}>
          {err}
        </div>
      )}

      {step === 0 && (
        <section style={{ ...card, padding: "1.2rem" }}>
          <h2 style={{ marginTop: 0, fontSize: "1.08rem" }}>Which repository do you want to deploy?</h2>
          <p style={{ color: colors.dim, fontSize: "0.92rem", lineHeight: 1.65 }}>
            Paste a GitHub repo. ShipFix supports Vite and Next.js frontends on Vercel, Node APIs on Render, and Postgres on Neon.
            Other stacks get an honest diagnosis instead of a fake green deploy.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: "0.75rem" }}>
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
            <button
              onClick={() => void startPlan()}
              disabled={starting || repo.trim().length === 0}
              style={buttonStyle("primary", starting || repo.trim().length === 0)}
            >
              {starting ? "Analyzing..." : "Analyze repo"}
            </button>
          </div>
        </section>
      )}

      {step === 1 && (
        <section>
          <div style={{ ...card, background: colors.panelSoft }}>
            <strong>Building your deployment plan</strong>
            <p style={{ margin: "0.4rem 0 0", color: colors.dim, lineHeight: 1.55 }}>
              ShipFix is reading <code style={{ fontFamily: mono }}>{repo}</code>, identifying services, and checking whether it can deploy them safely.
            </p>
          </div>
          <WorkerStalledNotice show={run.workerStalled && !run.controlPlaneMismatch} />
          <ControlPlaneConsistencyNotice show={run.controlPlaneMismatch} />
          <Timeline events={run.events} />
          {run.status === "failed" && !capturedPlan && (
            <div style={{ ...card, borderColor: colors.errorBorder, background: colors.errorBg, color: colors.errorText, marginTop: "1rem" }}>
              <p style={{ margin: 0 }}>{planFailureMessage(run.events)}</p>
              <button onClick={() => setStep(0)} style={{ ...buttonStyle("ghost"), marginTop: 12 }}>
                Back to repository
              </button>
            </div>
          )}
        </section>
      )}

      {step === 2 && capturedPlan && (
        <section>
          <PlanPanel
            plan={capturedPlan}
            runId={planRunId ?? undefined}
            answeredQuestionIds={run.snapshot?.answeredQuestionIds ?? []}
            onAnswersSaved={() => void run.refreshSnapshot()}
          />
          <ProviderRequirements plan={capturedPlan} connected={connected} onConnected={refreshProviders} />
          <div style={{ display: "flex", gap: 10, marginTop: "1.5rem", flexWrap: "wrap" }}>
            <button
              onClick={() => void startDeploy()}
              disabled={!canDeploy || starting}
              title={deployDisabledReason}
              style={buttonStyle("success", !canDeploy || starting)}
            >
              {starting ? "Starting deploy..." : "Deploy this plan"}
            </button>
            {showRecheck && (
              <button onClick={() => void startPlan()} disabled={starting} style={buttonStyle("ghost", starting)}>
                {starting ? "Re-checking..." : "Re-check plan"}
              </button>
            )}
            <button onClick={() => void refreshProviders()} style={buttonStyle("ghost")}>
              Refresh connections
            </button>
          </div>
          {!allConnected ? (
            <p style={{ marginTop: "0.65rem", fontSize: "0.86rem", color: colors.warn }}>
              Connect {missing.map((m) => m.provider).join(", ")} above to enable deploy.
            </p>
          ) : classification === "diagnose_only" ? (
            <p style={{ marginTop: "0.65rem", fontSize: "0.86rem", color: colors.warn, lineHeight: 1.55 }}>
              Deploy is disabled: this app is outside what ShipFix can auto-deploy (Vite/Next.js frontends, Node APIs, Neon Postgres). Use the diagnosis above as the next step, or re-check if you just connected providers.
            </p>
          ) : classification === "needs_setup" ? (
            <p style={{ marginTop: "0.65rem", fontSize: "0.86rem", color: colors.warn, lineHeight: 1.55 }}>
              Deploy is disabled until the setup items above are resolved (secrets, repo fixes, or provider setup). Re-check the plan after addressing them — ShipFix re-validates before any provider call.
            </p>
          ) : null}
        </section>
      )}

      {step === 3 && (
        <section>
          <div style={{ ...card, background: colors.panelSoft }}>
            <strong>Deploying and verifying</strong>
            <p style={{ margin: "0.4rem 0 0", color: colors.dim, lineHeight: 1.55 }}>
              ShipFix provisions the database, deploys backend and frontend services, wires env vars, and verifies the live system.
            </p>
          </div>
          <WorkerStalledNotice show={run.workerStalled && !run.controlPlaneMismatch} />
          <ControlPlaneConsistencyNotice show={run.controlPlaneMismatch} />
          <Timeline events={run.events} />
        </section>
      )}

      {step === 4 && (
        <section>
          <OutcomeBanner status={run.status} snapshot={run.snapshot} />
          <FixGuidance events={run.events} />
          <Timeline events={run.events} />
          <div style={{ display: "flex", gap: 10, marginTop: "1.5rem", flexWrap: "wrap" }}>
            {run.snapshot?.run.projectId && (
              <Link href={`/apps/${run.snapshot.run.projectId}`} style={{ textDecoration: "none" }}>
                <button style={buttonStyle("primary")}>View app details</button>
              </Link>
            )}
            {(run.status === "diagnosed" || run.status === "failed") && (
              <button onClick={() => void startDeploy()} disabled={starting} style={buttonStyle("ghost", starting)}>
                {starting ? "Retrying..." : "Retry deploy"}
              </button>
            )}
            <Link href="/" style={{ textDecoration: "none" }}>
              <button style={buttonStyle("ghost")}>Back to My Apps</button>
            </Link>
          </div>
        </section>
      )}
    </main>
  );
}
