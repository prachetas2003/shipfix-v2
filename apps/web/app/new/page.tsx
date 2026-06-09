"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, type PlanView } from "../lib/api";
import { deriveRequiredProviders, missingProviders } from "../lib/planRequirements";
import { useRun } from "../lib/useRun";
import { buttonStyle, card, colors, inputStyle, mono } from "../lib/theme";
import { FixGuidance } from "../components/FixGuidance";
import { OutcomeBanner } from "../components/OutcomeBanner";
import { PlanPanel } from "../components/PlanPanel";
import { ProviderRequirements } from "../components/ProviderRequirements";
import { Stepper } from "../components/Stepper";
import { Timeline } from "../components/Timeline";
import type { RunEventRow } from "../lib/api";

const STEPS = ["Repository", "Plan", "Connect", "Deploy", "Result"];

function planFailureMessage(events: RunEventRow[]): string {
  const lastFailure = [...events].reverse().find((ev) => {
    const event = typeof ev.data?.event === "string" ? ev.data.event : "";
    return ["usage_limit_reached", "llm_config_missing", "planning_failed", "run_failed"].includes(event);
  });
  const event = typeof lastFailure?.data?.event === "string" ? lastFailure.data.event : "";
  const message = typeof lastFailure?.data?.message === "string" ? lastFailure.data.message : "";
  if (event === "usage_limit_reached") return message || "Usage limit reached. Try again later, or raise the local alpha limits while testing.";
  if (event === "llm_config_missing") {
    return message || "Planner setup is missing. Add backend-only LLM env vars to the worker environment, restart the worker, then try again.";
  }
  return message || "ShipFix couldn't produce a plan for this repo. Check the timeline details and try again.";
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

  // Advance Plan -> Connect once a plan is available.
  useEffect(() => {
    if (step === 1 && capturedPlan) setStep(2);
  }, [step, capturedPlan]);

  // Advance Deploy -> Result when the deploy run reaches a terminal state.
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
  // Deploy needs the required providers connected. Classification is re-validated
  // server-side at deploy time (the workflow `gateDeploy` is authoritative and
  // never calls a provider for a non-green plan), so the button enables on
  // connection; non-green plans get an honest heads-up below and a re-check.
  const canDeploy = allConnected;
  // When everything is connected but the (possibly stale) plan still isn't green,
  // re-analyzing with the new connections often flips it to deployable.
  const showRecheck = allConnected && classification !== "deployable";

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "2.5rem 1.5rem 6rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: "1.5rem" }}>
        <Link href="/" style={{ color: colors.dim, textDecoration: "none", fontSize: "0.85rem" }}>
          ← My Apps
        </Link>
        <h1 style={{ fontSize: "1.6rem", margin: 0 }}>New deployment</h1>
      </div>

      <Stepper steps={STEPS} current={step} />

      {err && <p style={{ color: colors.error, fontSize: "0.9rem" }}>{err}</p>}

      {/* Step 1: Repository */}
      {step === 0 && (
        <section style={card}>
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Which repository do you want to deploy?</h2>
          <p style={{ opacity: 0.7, fontSize: "0.9rem", lineHeight: 1.6 }}>
            Paste a GitHub repo. ShipFix will read it, detect your database/backend/frontend, and
            build a deployment plan. You only connect provider keys once the plan tells you what's
            needed. ShipFix auto-deploys Vite frontends, Node APIs, and Postgres; other stacks get a
            diagnosis with next steps instead of a broken deploy.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "0.5rem" }}>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && repo.trim() && !starting) void startPlan();
              }}
              placeholder="owner/repo  or  https://github.com/owner/repo"
              spellCheck={false}
              style={{ ...inputStyle, flex: 1, minWidth: 280, fontFamily: mono }}
            />
            <button
              onClick={() => void startPlan()}
              disabled={starting || repo.trim().length === 0}
              style={buttonStyle("primary", starting || repo.trim().length === 0)}
            >
              {starting ? "Analyzing…" : "Analyze repository"}
            </button>
          </div>
        </section>
      )}

      {/* Step 2: Plan (live while analyzing) */}
      {step === 1 && (
        <section>
          <p style={{ opacity: 0.75 }}>
            Analyzing <code style={{ fontFamily: mono }}>{repo}</code> and building your plan…
          </p>
          <Timeline events={run.events} />
          {run.status === "failed" && !capturedPlan && (
            <p style={{ color: colors.error, marginTop: "1rem" }}>
              {planFailureMessage(run.events)}
              <button onClick={() => setStep(0)} style={{ ...buttonStyle("ghost"), marginLeft: 12 }}>
                Back
              </button>
            </p>
          )}
        </section>
      )}

      {/* Step 3: Plan review + connect required providers */}
      {step === 2 && capturedPlan && (
        <section>
          <PlanPanel plan={capturedPlan} />
          <ProviderRequirements plan={capturedPlan} connected={connected} onConnected={refreshProviders} />
          <div style={{ display: "flex", gap: 10, marginTop: "1.5rem", flexWrap: "wrap" }}>
            <button
              onClick={() => void startDeploy()}
              disabled={!canDeploy || starting}
              title={
                canDeploy
                  ? "Provision + deploy + verify"
                  : "Connect the required providers first"
              }
              style={buttonStyle("success", !canDeploy || starting)}
            >
              {starting ? "Starting deploy…" : "Deploy"}
            </button>
            {showRecheck && (
              <button onClick={() => void startPlan()} disabled={starting} style={buttonStyle("ghost", starting)}>
                {starting ? "Re-checking…" : "Re-check plan"}
              </button>
            )}
            <button onClick={() => void refreshProviders()} style={buttonStyle("ghost")}>
              Refresh connections
            </button>
          </div>
          {!allConnected ? (
            <p style={{ marginTop: "0.6rem", fontSize: "0.85rem", color: colors.warn }}>
              Connect {missing.map((m) => m.provider).join(", ")} above to enable Deploy.
            </p>
          ) : classification === "diagnose_only" ? (
            <p style={{ marginTop: "0.6rem", fontSize: "0.85rem", color: colors.warn }}>
              Heads up: this app is outside the auto-deployable slice. If you just connected providers,
              click <strong>Re-check plan</strong>. If the blockers above are about your repo (unsupported
              stack, migrations, secrets), deploying will produce a diagnosis — not a live app — until you
              resolve them.
            </p>
          ) : classification === "needs_setup" ? (
            <p style={{ marginTop: "0.6rem", fontSize: "0.85rem", color: colors.warn }}>
              This plan still has setup items above. If you just connected providers, click{" "}
              <strong>Re-check plan</strong>. Otherwise resolve the blockers (secrets, migrations) — ShipFix
              re-validates at deploy time and won't call providers for a plan it can't ship.
            </p>
          ) : null}
        </section>
      )}

      {/* Step 4: Deploy (live) */}
      {step === 3 && (
        <section>
          <p style={{ opacity: 0.75 }}>
            Deploying your app. This provisions the database, deploys backend and frontend, wires
            them together, and verifies live checks.
          </p>
          <Timeline events={run.events} />
        </section>
      )}

      {/* Step 5: Result */}
      {step === 4 && (
        <section>
          <OutcomeBanner status={run.status} snapshot={run.snapshot} />
          <FixGuidance events={run.events} />
          <Timeline events={run.events} />
          <div style={{ display: "flex", gap: 10, marginTop: "1.5rem", flexWrap: "wrap" }}>
            {run.snapshot?.run.projectId && (
              <Link href={`/apps/${run.snapshot.run.projectId}`} style={{ textDecoration: "none" }}>
                <button style={buttonStyle("primary")}>View this app</button>
              </Link>
            )}
            {(run.status === "diagnosed" || run.status === "failed") && (
              <button onClick={() => void startDeploy()} disabled={starting} style={buttonStyle("ghost", starting)}>
                {starting ? "Retrying…" : "Rerun deploy"}
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
