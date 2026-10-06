"use client";

import type { RunSnapshot } from "../lib/api";
import { buildAppResourceDisplay } from "../lib/resourceDisplay";
import { CurrentState } from "./CurrentState";
import { VerificationChecklist } from "./VerificationChecklist";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Panel } from "./ui/Panel";
import { colors } from "../lib/theme";

/**
 * Quiet status-first outcome: badge + one sentence + stack + checks.
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
      ? "Plan ready — not deployed yet"
      : runStatus === "failed"
        ? deployFailureHeadline(snapshot)
        : runStatus === "succeeded"
          ? "Deploy finished with partial verification"
          : runStatus === "diagnosed" && hasAnyLiveResource
            ? "Deploy needs attention"
            : terminal
              ? "Deploy finished without full verification"
              : hasAnyLiveResource
                ? "Part of the stack is live"
                : "Deployment in progress";

  const badgeTone = allLive
    ? "success"
    : runStatus === "failed"
      ? "error"
      : runStatus === "diagnosed" || (!allLive && terminal)
        ? "warn"
        : "info";

  const badgeLabel = allLive
    ? "Live"
    : runStatus === "failed"
      ? "Failed"
      : runStatus === "diagnosed"
        ? "Needs attention"
        : terminal
          ? "Partial"
          : "In progress";

  const nextAction =
    (!allLive && snapshot.diagnoses?.[0]?.action) || computeNextAction(display, status);

  return (
    <section className="sf-slide-up" style={{ marginBottom: "1.25rem" }}>
      <Panel>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 420px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <Badge tone={badgeTone}>{badgeLabel}</Badge>
            </div>
            <h2 style={{ margin: "0.65rem 0 0", fontSize: "1.25rem", fontWeight: 600, letterSpacing: "-0.02em" }}>
              {headline}
            </h2>
            {!allLive && nextAction && (
              <p style={{ margin: "0.45rem 0 0", color: colors.dim, lineHeight: 1.55, fontSize: "0.9rem" }}>
                {nextAction}
              </p>
            )}
            {allLive && (
              <p style={{ margin: "0.45rem 0 0", color: colors.dim, lineHeight: 1.55, fontSize: "0.9rem" }}>
                Database, backend, and frontend are deployed and verified.
              </p>
            )}
          </div>
          {display.frontend?.openAppUrl && (
            <a href={display.frontend.openAppUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
              <Button variant="success">Open app</Button>
            </a>
          )}
        </div>

        {!allLive && (snapshot.diagnoses?.length ?? 0) > 0 && (
          <ul style={{ listStyle: "none", margin: "1rem 0 0", padding: 0, display: "grid", gap: 8 }}>
            {snapshot.diagnoses!.map((diag, i) => (
              <li
                key={`${diag.code}-${i}`}
                style={{
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  padding: "0.65rem 0.75rem",
                  background: colors.panelSoft,
                }}
              >
                <div style={{ fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase", color: colors.dim, letterSpacing: "0.04em" }}>
                  {diagnosisTitle(diag.code)}
                </div>
                <p style={{ margin: "0.3rem 0 0", color: colors.muted, lineHeight: 1.5, fontSize: "0.88rem" }}>{diag.action}</p>
              </li>
            ))}
          </ul>
        )}

        <div style={{ marginTop: "1rem" }}>
          <VerificationChecklist verification={snapshot.verification} plan={snapshot.plan} />
        </div>
      </Panel>
      <div style={{ marginTop: "0.85rem" }}>
        <CurrentState display={display} />
      </div>
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
      ? "Queued — waiting for the worker."
      : "Still running — activity updates live.";
  }
  if (status === "succeeded") return "Connect providers, then deploy this plan.";
  if (display.database?.state === "failed") return `Database was not created. Check ${display.database.provider === "upstash" ? "Upstash" : "Neon"} and retry.`;
  if (display.backend?.state === "failed") return "Backend deploy failed. Check Render logs, then retry.";
  if (display.frontend?.state === "failed") return "Frontend deploy failed. Update Vercel credentials or fix the build, then retry.";
  if (status === "failed") return "Review the guidance below, fix the issue, and retry.";
  return "Verification did not pass. Review the failed check.";
}

function deployFailureHeadline(snapshot: RunSnapshot): string {
  if (snapshot.resources.some((r) => r.role === "database" && r.status === "failed")) {
    return "Failed during database provisioning";
  }
  if (snapshot.resources.some((r) => r.role === "backend" && r.status === "failed")) {
    return "Backend deploy failed";
  }
  if (snapshot.resources.some((r) => r.role === "frontend" && r.status === "failed")) {
    return "Frontend deploy failed";
  }
  return "Deploy did not produce a live app";
}
