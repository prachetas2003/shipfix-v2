"use client";

import Link from "next/link";
import type { AppSummary, LayerState, VerificationEntry } from "../lib/api";
import { buildAppResourceDisplay, providerConsoleLabel } from "../lib/resourceDisplay";
import { runStatusLabel } from "../lib/runLabels";
import { colors, mono } from "../lib/theme";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { StatusDot } from "./ui/StatusDot";

function badgeToneForRun(status: string | undefined): "success" | "warn" | "error" | "neutral" | "info" {
  if (!status) return "neutral";
  if (status === "succeeded") return "success";
  if (status === "diagnosed") return "warn";
  if (status === "failed") return "error";
  return "info";
}

function MiniStatus({ label, state }: { label: string; state: LayerState }): React.ReactElement {
  const tone = state === "live" ? "live" : state === "failed" ? "failed" : state === "provisioning" ? "provisioning" : "neutral";
  const copy = state === "live" ? "Live" : state === "failed" ? "Failed" : state === "provisioning" ? "In progress" : "—";
  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        background: colors.panelSoft,
        borderRadius: 8,
        padding: "0.55rem 0.7rem",
        minWidth: 120,
      }}
    >
      <div style={{ color: colors.dim, fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 4 }}>
        <StatusDot tone={tone} />
        <span style={{ fontSize: "0.84rem", fontWeight: 500 }}>{copy}</span>
      </div>
    </div>
  );
}

export function AppCard({
  app,
}: {
  app: AppSummary;
  verification?: VerificationEntry[];
}): React.ReactElement {
  const run = app.latestRun;
  const display = buildAppResourceDisplay({
    resources: app.resources,
    layers: app.layers,
    verification: app.verification ?? [],
  });
  const live = Boolean(display?.fullStack.live);
  const lastDeployedAt = app.liveDeployment && run?.finishedAt ? run.finishedAt : run?.startedAt;

  return (
    <article className="sf-panel sf-slide-up" style={{ padding: "1rem 1.1rem" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
          <Link
            href={`/apps/${app.projectId}`}
            style={{
              textDecoration: "none",
              color: "inherit",
              fontFamily: mono,
              fontWeight: 600,
              fontSize: "0.95rem",
              wordBreak: "break-word",
            }}
          >
            {app.repoFullName}
          </Link>
          <p style={{ margin: "0.3rem 0 0", color: colors.dim, fontSize: "0.82rem", lineHeight: 1.45 }}>
            {live
              ? "Verified live across frontend, backend, and database."
              : app.liveDeployment
                ? "Previous live deploy preserved; latest run needs attention."
                : "No verified live deployment yet."}
          </p>
        </div>
        {run && <Badge tone={badgeToneForRun(run.status)}>{runStatusLabel(run.mode, run.status)}</Badge>}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "0.85rem" }}>
        <MiniStatus label="Frontend" state={display?.frontend?.state ?? "not_attempted"} />
        <MiniStatus label="API" state={display?.backend?.state ?? "not_attempted"} />
        <MiniStatus label="Database" state={display?.database?.state ?? "not_attempted"} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: "0.9rem" }}>
        {display?.frontend?.openAppUrl ? (
          <a href={display.frontend.openAppUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <Button variant="success">Open app</Button>
          </a>
        ) : null}
        {display?.frontend?.consoleUrl && (
          <a href={display.frontend.consoleUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <Button variant="ghost">{providerConsoleLabel(display.frontend.provider)}</Button>
          </a>
        )}
        <Link href={`/apps/${app.projectId}`} style={{ textDecoration: "none" }}>
          <Button variant="ghost">Details</Button>
        </Link>
        {lastDeployedAt && (
          <span style={{ marginLeft: "auto", color: colors.dim, fontSize: "0.75rem" }}>
            {new Date(lastDeployedAt).toLocaleString()}
          </span>
        )}
      </div>
    </article>
  );
}
