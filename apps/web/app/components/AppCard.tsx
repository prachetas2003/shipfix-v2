"use client";

import Link from "next/link";
import type { AppSummary, LayerState, VerificationEntry } from "../lib/api";
import { buildAppResourceDisplay } from "../lib/resourceDisplay";
import { runStatusLabel } from "../lib/runLabels";
import { buttonStyle, card, colors, mono, STATE_COLOR } from "../lib/theme";
import { VerificationChecklist } from "./VerificationChecklist";
import { providerConsoleLabel } from "../lib/resourceDisplay";

const STATUS_COLOR: Record<string, string> = {
  succeeded: colors.success,
  diagnosed: colors.warn,
  failed: colors.error,
  queued: colors.dim,
  analyzing: colors.accentText,
  planning: colors.accentText,
  provisioning: colors.accentText,
  deploying: colors.accentText,
  verifying: colors.accentText,
};

const STATE_COPY: Record<LayerState, string> = {
  live: "Live",
  failed: "Failed",
  provisioning: "In progress",
  not_attempted: "Not deployed",
};

function MiniStatus({ label, state }: { label: string; state: LayerState }): React.ReactElement {
  const color = STATE_COLOR[state] ?? colors.dim;
  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        background: colors.panelSoft,
        borderRadius: 8,
        padding: "0.65rem 0.75rem",
        minWidth: 150,
      }}
    >
      <div style={{ color: colors.dim, fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0 }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: color }} />
        <strong style={{ fontSize: "0.86rem" }}>{STATE_COPY[state] ?? state}</strong>
      </div>
    </div>
  );
}

export function AppCard({
  app,
  verification = [],
}: {
  app: AppSummary;
  verification?: VerificationEntry[];
}): React.ReactElement {
  const run = app.latestRun;
  const statusColor = run ? STATUS_COLOR[run.status] ?? colors.dim : colors.dim;
  const display = buildAppResourceDisplay({
    resources: app.resources,
    layers: app.layers,
    verification,
  });
  const live = Boolean(display?.fullStack.live);
  const lastDeployedAt = app.liveDeployment && run?.finishedAt ? run.finishedAt : run?.startedAt;

  return (
    <article style={{ ...card, marginBottom: 14, padding: "1.1rem" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 420px", minWidth: 0 }}>
          <Link
            href={`/apps/${app.projectId}`}
            style={{ textDecoration: "none", color: "inherit", fontFamily: mono, fontWeight: 700, fontSize: "1rem", wordBreak: "break-word" }}
          >
            {app.repoFullName}
          </Link>
          <p style={{ margin: "0.35rem 0 0", color: colors.dim, fontSize: "0.86rem", lineHeight: 1.5 }}>
            {live
              ? "Live deployment verified across frontend, backend, and database."
              : app.liveDeployment
                ? "A previous live deployment is preserved while the latest run needs attention."
                : "No verified live deployment yet."}
          </p>
        </div>

        {run && (
          <span
            style={{
              fontSize: "0.74rem",
              fontWeight: 800,
              color: "#061014",
              background: statusColor,
              padding: "0.22rem 0.65rem",
              borderRadius: 999,
              whiteSpace: "nowrap",
            }}
          >
            {runStatusLabel(run.mode, run.status)}
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: "1rem" }}>
        <MiniStatus label="Frontend" state={display?.frontend?.state ?? "not_attempted"} />
        <MiniStatus label="Backend API" state={display?.backend?.state ?? "not_attempted"} />
        <MiniStatus label="Database" state={display?.database?.state ?? "not_attempted"} />
      </div>

      {verification.length > 0 && <VerificationChecklist verification={verification} compact />}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: "1rem" }}>
        {display?.frontend?.openAppUrl ? (
          <a
            href={display.frontend.openAppUrl}
            target="_blank"
            rel="noreferrer"
            style={{ ...buttonStyle("success"), textDecoration: "none", display: "inline-block" }}
          >
            Open app
          </a>
        ) : (
          <span style={{ color: colors.dim, fontSize: "0.85rem" }}>Frontend link appears after a verified deploy.</span>
        )}
        {display?.frontend?.consoleUrl && (
          <a
            href={display.frontend.consoleUrl}
            target="_blank"
            rel="noreferrer"
            style={{ ...buttonStyle("ghost"), textDecoration: "none", display: "inline-block" }}
          >
            {providerConsoleLabel(display.frontend.provider)}
          </a>
        )}
        <Link href={`/apps/${app.projectId}`} style={{ textDecoration: "none" }}>
          <button style={buttonStyle("ghost")}>View deployment details</button>
        </Link>
        {lastDeployedAt && (
          <span style={{ marginLeft: "auto", color: colors.dim, fontSize: "0.78rem" }}>
            Last activity {new Date(lastDeployedAt).toLocaleString()}
          </span>
        )}
      </div>
    </article>
  );
}
