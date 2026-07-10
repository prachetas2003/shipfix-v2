"use client";

import type { PlanView, VerificationEntry } from "../lib/api";
import { colors } from "../lib/theme";

export function VerificationChecklist({
  verification,
  plan,
  compact = false,
}: {
  verification: VerificationEntry[];
  plan?: Pick<PlanView, "verification"> | null;
  compact?: boolean;
}): React.ReactElement | null {
  const planned = plan?.verification ?? [];
  if (planned.length === 0 && verification.length === 0) return null;

  const latest = new Map<string, VerificationEntry>();
  for (const v of verification) {
    latest.set(`${v.serviceId}.${v.check}`, v);
  }

  const rows =
    planned.length > 0
      ? planned.map((p) => {
          const key = `${p.serviceId}.${p.check}`;
          const entry = latest.get(key);
          return {
            key,
            label: verificationLabel(p.check, p.serviceId, p.target),
            shortLabel: shortVerificationLabel(p.check),
            state: entry
              ? entry.skipped
                ? "skipped"
                : entry.ok
                  ? "pass"
                  : "fail"
              : "pending",
          };
        })
      : [...latest.values()].map((v) => ({
          key: `${v.serviceId}.${v.check}`,
          label: verificationLabel(v.check, v.serviceId, null),
          shortLabel: shortVerificationLabel(v.check),
          state: v.skipped ? "skipped" : v.ok ? "pass" : "fail",
        }));

  if (compact) {
    return (
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: "0.75rem" }}>
        {rows.map((row) => (
          <span
            key={row.key}
            style={{
              fontSize: "0.72rem",
              fontWeight: 700,
              borderRadius: 999,
              padding: "0.18rem 0.55rem",
              border: `1px solid ${colors.border}`,
              background: colors.panelSoft,
              color:
                row.state === "pass"
                  ? colors.successText
                  : row.state === "fail"
                    ? colors.errorText
                    : colors.warnText,
            }}
          >
            {row.shortLabel}:{" "}
            {row.state === "pass" ? "Pass" : row.state === "fail" ? "Fail" : row.state === "skipped" ? "Skip" : "…"}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div style={{ marginTop: "1rem" }}>
      <div
        style={{
          color: colors.dim,
          fontSize: "0.72rem",
          fontWeight: 800,
          textTransform: "uppercase",
          letterSpacing: 0,
          marginBottom: 8,
        }}
      >
        Verification
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {rows.map((row) => (
          <li
            key={row.key}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              fontSize: "0.88rem",
              color: colors.text,
            }}
          >
            <span>{row.label}</span>
            <span
              style={{
                fontWeight: 700,
                color:
                  row.state === "pass"
                    ? colors.successText
                    : row.state === "fail"
                      ? colors.errorText
                      : colors.warnText,
              }}
            >
              {row.state === "pass" ? "Pass" : row.state === "fail" ? "Fail" : row.state === "skipped" ? "Skipped" : "Pending"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function shortVerificationLabel(check: string): string {
  switch (check) {
    case "frontend_loads":
      return "Frontend";
    case "health_path":
    case "http_2xx":
      return "Health";
    case "cors_from":
      return "CORS";
    case "db_connect":
      return "DB";
    default:
      return check;
  }
}

function verificationLabel(check: string, serviceId: string, target: string | null | undefined): string {
  switch (check) {
    case "frontend_loads":
      return `Frontend loads (${serviceId})`;
    case "health_path":
      return `Backend health (${serviceId}${target ? ` ${target}` : ""})`;
    case "cors_from":
      return `Frontend → backend CORS (${target ?? "web"} → ${serviceId})`;
    case "db_connect":
      return `Database reachable (${serviceId})`;
    case "http_2xx":
      return `HTTP check (${serviceId})`;
    default:
      return `${check} (${serviceId})`;
  }
}
