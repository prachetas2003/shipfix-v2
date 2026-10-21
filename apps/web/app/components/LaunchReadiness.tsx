"use client";

import { colors } from "../lib/theme";
import { Panel } from "./ui/Panel";

export interface ReadinessReport {
  score: number;
  historyScanned?: boolean;
  findings: Array<{
    code: string;
    severity: "high" | "medium" | "low";
    title: string;
    detail: string;
    file?: string;
    fixable?: boolean;
  }>;
}

export function readinessFrom(repoContext: unknown): ReadinessReport | null {
  const security = (repoContext as { security?: ReadinessReport } | null)?.security;
  if (!security || typeof security.score !== "number" || !Array.isArray(security.findings)) return null;
  return security;
}

/** Score from the static scan. A live database is never contacted. */
export function LaunchReadiness({ report }: { report: ReadinessReport | null }): React.ReactElement | null {
  if (!report) return null;
  const tone = report.score >= 80 ? colors.success : report.score >= 50 ? colors.warn : colors.error;
  return (
    <Panel className="sf-slide-up" style={{ marginBottom: "0.85rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <strong style={{ fontWeight: 600 }}>Launch readiness</strong>
        <span style={{ color: tone, fontWeight: 700 }}>{report.score}/100</span>
      </div>
      <p style={{ margin: "0.4rem 0 0", color: colors.dim, fontSize: "0.84rem", lineHeight: 1.5 }}>
        Checked the files in this commit.
        {report.historyScanned
          ? " Older commits were checked too."
          : " Older git history was not, because the clone only has this commit."}{" "}
        ShipFix did not connect to a live database.
      </p>
      {report.findings.length === 0 ? (
        <p style={{ margin: "0.55rem 0 0", fontSize: "0.86rem" }}>No issues in this commit.</p>
      ) : (
        <ul style={{ margin: "0.7rem 0 0", paddingLeft: "1.1rem", display: "grid", gap: 8 }}>
          {report.findings.map((finding) => (
            <li key={`${finding.code}:${finding.file ?? ""}`} style={{ fontSize: "0.86rem", lineHeight: 1.45 }}>
              <strong>{finding.title}</strong>
              {finding.file ? <span style={{ color: colors.dim }}> · {finding.file}</span> : null}
              <div style={{ color: colors.muted }}>{finding.detail}</div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
