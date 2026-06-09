"use client";

import type { RunSnapshot } from "../lib/api";
import { buildAppResourceDisplay } from "../lib/resourceDisplay";
import { CurrentState } from "./CurrentState";
import { card, colors } from "../lib/theme";

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
  });
  if (!display) return null;

  const allLive = display.fullStack.live;
  const isPlanRun = snapshot.run.mode === "plan";
  const hasAnyLiveResource = snapshot.resources.some((r) => r.status === "live");
  const headline = allLive
    ? "Your app is live."
    : isPlanRun && status === "succeeded"
      ? "Plan generated. App not deployed yet."
      : status === "failed"
        ? deployFailureHeadline(snapshot)
        : hasAnyLiveResource
          ? "Partly live - a few things still need attention."
          : "App not deployed yet.";

  const tone = allLive
    ? { border: colors.successDeep, bg: colors.successBg, text: colors.successText }
    : status === "failed" && !hasAnyLiveResource
      ? { border: colors.errorBorder, bg: colors.errorBg, text: colors.errorText }
      : { border: colors.warnBorder, bg: colors.warnBg, text: colors.warnText };

  const nextAction = computeNextAction(display, status);

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <div
        style={{
          ...card,
          borderColor: tone.border,
          background: tone.bg,
          padding: "0.85rem 1rem",
          marginBottom: "0.75rem",
        }}
      >
        <span style={{ fontSize: "1.1rem", fontWeight: 700, color: tone.text }}>{headline}</span>
        {display.frontend?.openAppUrl && (
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.88rem", color: tone.text }}>
            Share and use your{" "}
            <a href={display.frontend.openAppUrl} target="_blank" rel="noreferrer" style={{ color: colors.successText, fontWeight: 600 }}>
              frontend app link
            </a>
            . Backend and database power it behind the scenes.
          </p>
        )}
        {nextAction && (
          <p style={{ margin: "0.6rem 0 0", color: tone.text, fontSize: "0.9rem" }}>
            <strong>Next:</strong> {nextAction}
          </p>
        )}
      </div>
      <CurrentState display={display} />
    </section>
  );
}

function computeNextAction(
  display: NonNullable<ReturnType<typeof buildAppResourceDisplay>>,
  status: string,
): string | null {
  if (display.fullStack.live) return null;
  if (status === "succeeded") {
    return "Connect providers and deploy this plan.";
  }
  if (display.frontend && display.frontend.state !== "live") {
    return "Your frontend is not live. Make sure GitHub is connected to Vercel and the repo is accessible, then rerun Deploy.";
  }
  if (display.database && display.database.state === "failed") {
    return "Database provisioning failed. Check the provider setup, then retry Deploy.";
  }
  if (display.backend && display.backend.state === "failed") {
    return "Your backend did not deploy. Open the timeline's technical details for the provider error, then rerun Deploy.";
  }
  if (status === "failed") {
    return "No live result yet. Review the timeline, fix the flagged setup, and rerun Deploy.";
  }
  return "Review the timeline below for the remaining gap, then rerun Deploy.";
}

function deployFailureHeadline(snapshot: RunSnapshot): string {
  const failedDb = snapshot.resources.some((r) => r.role === "database" && r.status === "failed");
  if (failedDb) return "Deploy failed during database provisioning.";
  return "Deploy did not produce a live app.";
}
