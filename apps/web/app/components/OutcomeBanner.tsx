"use client";

import type { RunSnapshot } from "../lib/api";
import { buildAppResourceDisplay } from "../lib/resourceDisplay";
import { CurrentState } from "./CurrentState";
import { VerificationChecklist } from "./VerificationChecklist";
import { buttonStyle, card, colors } from "../lib/theme";

/**
 * Honest, per-layer outcome with resource-type-aware links (frontend primary,
 * backend health URL, database as metadata).
 */
export function OutcomeBanner({
  status,
  snapshot,
}: {
  status: string;
  snapshot: RunSnapshot | null;
}): React.ReactElement | null {
  if (!snapshot) return null;

  const display = buildAppResourceDisplay({
    resources: snapshot.resources,
    layers: snapshot.layers,
    verification: snapshot.verification,
    plan: snapshot.plan,
  });
  if (!display) return null;

  const allLive = display.fullStack.live;
  const isPlanRun = snapshot.run.mode === "plan";
  const runStatus = status;
  const terminal = runStatus === "succeeded" || runStatus === "diagnosed" || runStatus === "failed";
  const hasAnyLiveResource = snapshot.resources.some((r) => r.status === "live");
  const headline = allLive
    ? "Your app is live"
    : isPlanRun && runStatus === "succeeded"
      ? "Plan generated. App not deployed yet."
      : runStatus === "failed"
        ? deployFailureHeadline(snapshot)
        : runStatus === "succeeded"
          ? "Deploy succeeded with partial verification"
          : runStatus === "diagnosed" && hasAnyLiveResource
            ? "Deploy needs attention"
            : terminal
              ? "Deploy finished without full verification"
              : hasAnyLiveResource
                ? "Part of the stack is live, but verification is not complete."
                : "App not deployed yet.";

  const tone = allLive
    ? { border: colors.successDeep, bg: colors.successBg, text: colors.successText }
    : status === "failed" && !hasAnyLiveResource
      ? { border: colors.errorBorder, bg: colors.errorBg, text: colors.errorText }
      : { border: colors.warnBorder, bg: colors.warnBg, text: colors.warnText };

  const nextAction =
    (!allLive && snapshot.diagnoses?.[0]?.action) ||
    computeNextAction(display, status);

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <div
        style={{
          ...card,
          borderColor: tone.border,
          background: tone.bg,
          padding: allLive ? "1.35rem" : "1rem",
          marginBottom: "0.9rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 460px" }}>
            <p style={{ margin: 0, color: tone.text, fontSize: "0.82rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: 0 }}>
              {allLive ? "Verified deployment" : "Deployment outcome"}
            </p>
            <h2 style={{ margin: "0.35rem 0 0", color: tone.text, fontSize: allLive ? "1.65rem" : "1.15rem", letterSpacing: 0 }}>
              {headline}
            </h2>
            <p style={{ margin: "0.55rem 0 0", color: tone.text, opacity: 0.9, lineHeight: 1.55 }}>
              {allLive
                ? "ShipFix created the database, deployed the backend and frontend, wired the environment variables, and verified the live app."
                : nextAction}
            </p>
          </div>
          {display.frontend?.openAppUrl && (
            <a
              href={display.frontend.openAppUrl}
              target="_blank"
              rel="noreferrer"
              style={{ ...buttonStyle("success"), textDecoration: "none", display: "inline-block" }}
            >
              Open app
            </a>
          )}
        </div>

        {allLive && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginTop: "1rem" }}>
            <SummaryItem label="Frontend" value="Vercel app is live" />
            <SummaryItem label="Backend" value={display.backend?.healthCheckPassed ? "Render health check passed" : "Render service deployed"} />
            <SummaryItem label="Database" value="Neon Postgres verified" />
          </div>
        )}

        {!allLive && (snapshot.diagnoses?.length ?? 0) > 0 && (
          <ul style={{ listStyle: "none", margin: "1rem 0 0", padding: 0, display: "grid", gap: 8 }}>
            {snapshot.diagnoses!.map((diag, i) => (
              <li
                key={`${diag.code}-${i}`}
                style={{
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  padding: "0.7rem 0.8rem",
                  background: "rgba(0,0,0,0.12)",
                }}
              >
                <div style={{ fontSize: "0.72rem", fontWeight: 800, textTransform: "uppercase", color: tone.text, opacity: 0.75 }}>
                  {diagnosisTitle(diag.code)}
                  {diag.fromServiceId && diag.toServiceId
                    ? ` · ${diag.fromServiceId} → ${diag.toServiceId}`
                    : diag.serviceId
                      ? ` · ${diag.serviceId}`
                      : diag.managedId
                        ? ` · ${diag.managedId}`
                        : ""}
                </div>
                <p style={{ margin: "0.35rem 0 0", color: tone.text, lineHeight: 1.5, fontSize: "0.9rem" }}>{diag.action}</p>
              </li>
            ))}
          </ul>
        )}

        <VerificationChecklist verification={snapshot.verification} plan={snapshot.plan} />
      </div>
      <CurrentState display={display} />
    </section>
  );
}

function diagnosisTitle(code: string): string {
  switch (code) {
    case "cors_failed":
      return "CORS failed";
    case "db_unreachable":
      return "Database unreachable";
    case "health_failed":
      return "Health check failed";
    case "migration_failed":
      return "Migration failed";
    case "env_unresolved":
      return "Env unresolved";
    default:
      return code;
  }
}

function SummaryItem({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div style={{ border: `1px solid ${colors.successDeep}`, borderRadius: 8, background: "rgba(5,46,31,0.45)", padding: "0.75rem" }}>
      <div style={{ color: colors.successText, opacity: 0.75, fontSize: "0.72rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: 0 }}>
        {label}
      </div>
      <div style={{ color: colors.successText, marginTop: 4, fontWeight: 700, fontSize: "0.88rem" }}>{value}</div>
    </div>
  );
}

const IN_PROGRESS_STATUSES = new Set([
  "queued",
  "analyzing",
  "planning",
  "validating",
  "provisioning",
  "deploying",
  "verifying",
]);

function computeNextAction(
  display: NonNullable<ReturnType<typeof buildAppResourceDisplay>>,
  status: string,
): string | null {
  if (display.fullStack.live) return null;
  if (IN_PROGRESS_STATUSES.has(status)) {
    return status === "queued"
      ? "The run is queued and waiting for the deployment worker to pick it up."
      : "The run is still in progress — the timeline below updates live.";
  }
  if (status === "succeeded") {
    return "Connect the required providers, then deploy this plan.";
  }
  if (display.database && display.database.state === "failed") {
    return "The database was not created, so ShipFix did not deploy the backend. Check Neon setup and retry deploy.";
  }
  if (display.backend && display.backend.state === "failed") {
    return "Render could not deploy the backend. Open technical details for the build or provider error, then retry deploy.";
  }
  if (display.frontend && display.frontend.state === "failed") {
    return "Vercel could not deploy the frontend. Check GitHub access or build output, then retry deploy.";
  }
  if (status === "failed") {
    return "No live result yet. Review the timeline, fix the flagged setup or repo issue, and retry deploy.";
  }
  return "The app was not marked live because verification did not pass. Review the failed check below.";
}

function deployFailureHeadline(snapshot: RunSnapshot): string {
  const failedDb = snapshot.resources.some((r) => r.role === "database" && r.status === "failed");
  const failedBackend = snapshot.resources.some((r) => r.role === "backend" && r.status === "failed");
  const failedFrontend = snapshot.resources.some((r) => r.role === "frontend" && r.status === "failed");
  if (failedDb) return "Deploy failed during database provisioning.";
  if (failedBackend) return "Backend deploy failed.";
  if (failedFrontend) return "Frontend deploy failed.";
  return "Deploy did not produce a live app.";
}
