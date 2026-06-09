"use client";

import Link from "next/link";
import type { AppSummary, VerificationEntry } from "../lib/api";
import { buildAppResourceDisplay } from "../lib/resourceDisplay";
import { runStatusLabel } from "../lib/runLabels";
import { card, colors, mono } from "../lib/theme";

const STATUS_COLOR: Record<string, string> = {
  succeeded: colors.success,
  diagnosed: colors.warn,
  failed: colors.error,
};

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

  return (
    <div style={{ ...card, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Link
          href={`/apps/${app.projectId}`}
          style={{ textDecoration: "none", color: "inherit", fontFamily: mono, fontWeight: 600, fontSize: "1rem" }}
        >
          {app.repoFullName}
        </Link>
        {run && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: "0.72rem",
              fontWeight: 700,
              color: "#0b0b0b",
              background: statusColor,
              padding: "0.12rem 0.55rem",
              borderRadius: 999,
            }}
          >
            {runStatusLabel(run.mode, run.status)}
          </span>
        )}
      </div>

      {display?.frontend?.openAppUrl ? (
        <a
          href={display.frontend.openAppUrl}
          target="_blank"
          rel="noreferrer"
          style={{
            display: "inline-block",
            marginTop: "0.65rem",
            padding: "0.45rem 1rem",
            borderRadius: 8,
            background: colors.success,
            color: "#0b0b0b",
            fontWeight: 700,
            fontSize: "0.88rem",
            textDecoration: "none",
          }}
        >
          Open app →
        </a>
      ) : display ? (
        <p style={{ margin: "0.5rem 0 0", opacity: 0.55, fontSize: "0.82rem" }}>No live frontend URL yet.</p>
      ) : (
        <p style={{ margin: "0.5rem 0 0", opacity: 0.55, fontSize: "0.82rem" }}>No deployments yet.</p>
      )}

      {display && (
        <div style={{ marginTop: "0.6rem", fontSize: "0.78rem", opacity: 0.65, lineHeight: 1.6 }}>
          {display.backend?.healthCheckUrl && display.backend.healthCheckPassed && (
            <div>
              Backend health:{" "}
              <a
                href={display.backend.healthCheckUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{ color: colors.accentText, fontFamily: mono }}
              >
                verified
              </a>
            </div>
          )}
          {display.database?.host && (
            <div>
              Database: <code style={{ fontFamily: mono }}>{display.database.host}</code>
              <span style={{ opacity: 0.7 }}> (reachable)</span>
            </div>
          )}
          {display.fullStack.live && (
            <div style={{ color: colors.success, fontWeight: 600, marginTop: 2 }}>
              Full-stack live
            </div>
          )}
        </div>
      )}

      {run && (
        <p style={{ margin: "0.5rem 0 0", fontSize: "0.75rem", opacity: 0.45 }}>
          <Link href={`/apps/${app.projectId}`} style={{ color: colors.dim }}>
            View app details
          </Link>
          {" · "}
          latest run {new Date(run.startedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
