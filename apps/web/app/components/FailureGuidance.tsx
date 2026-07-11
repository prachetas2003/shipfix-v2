"use client";

import { useState } from "react";
import type { RunEventRow } from "../lib/api";
import { buttonStyle, card, colors, mono } from "../lib/theme";

export type GuidanceAction =
  | "fix_repo_code"
  | "update_credentials"
  | "fix_account_setup"
  | "resolve_provider_limit"
  | "resolve_env_conflict"
  | "retry_or_check_logs"
  | "inspect_error";

export interface FailureGuidanceData {
  action: GuidanceAction;
  title: string;
  whatHappened: string;
  whatYouShouldDo: string[];
  showCursorPrompt: boolean;
  fixPrompt: string | null;
  provider: string | null;
  serviceId: string | null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

/** Prefer the new structured event; fall back to legacy deploy_fix_guidance. */
export function extractFailureGuidance(events: RunEventRow[]): FailureGuidanceData | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (d.event === "deploy_failure_guidance") {
      const action = String(d.action ?? "inspect_error") as GuidanceAction;
      return {
        action,
        title: typeof d.title === "string" ? d.title : "What to do next",
        whatHappened: typeof d.whatHappened === "string" ? d.whatHappened : ev.message,
        whatYouShouldDo: asStringArray(d.whatYouShouldDo),
        showCursorPrompt: Boolean(d.showCursorPrompt),
        fixPrompt: typeof d.fixPrompt === "string" ? d.fixPrompt : null,
        provider: typeof d.provider === "string" ? d.provider : null,
        serviceId: typeof d.serviceId === "string" ? d.serviceId : null,
      };
    }
  }

  // Legacy: only repo-fix prompts were emitted.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (d.event !== "deploy_fix_guidance") continue;
    const fixPrompt = typeof d.fixPrompt === "string" ? d.fixPrompt : "";
    if (!fixPrompt) continue;
    return {
      action: "fix_repo_code",
      title: "Repo build/config failed",
      whatHappened: ev.message,
      whatYouShouldDo: asStringArray(d.checklist),
      showCursorPrompt: true,
      fixPrompt,
      provider: typeof d.provider === "string" ? d.provider : null,
      serviceId: typeof d.serviceId === "string" ? d.serviceId : null,
    };
  }
  return null;
}

function actionBadge(action: GuidanceAction): { label: string; color: string } {
  switch (action) {
    case "fix_repo_code":
      return { label: "Fix in your repo", color: colors.warn };
    case "update_credentials":
      return { label: "Update credentials", color: colors.accentText };
    case "fix_account_setup":
      return { label: "Provider account setup", color: colors.accentText };
    case "resolve_provider_limit":
      return { label: "Provider limit", color: colors.warn };
    case "resolve_env_conflict":
      return { label: "Provider env conflict", color: colors.warn };
    case "retry_or_check_logs":
      return { label: "Check provider / retry", color: colors.dim };
    default:
      return { label: "Inspect error", color: colors.dim };
  }
}

/**
 * Shows the classified next step for a deploy failure: credentials, account
 * setup, provider limit, or (only when appropriate) a Cursor/ChatGPT repo prompt.
 */
export function FailureGuidance({
  events,
  onUpdateCredentials,
}: {
  events: RunEventRow[];
  onUpdateCredentials?: () => void;
}): React.ReactElement | null {
  const [copied, setCopied] = useState(false);
  const guidance = extractFailureGuidance(events);
  if (!guidance) return null;

  const badge = actionBadge(guidance.action);
  const copy = async () => {
    if (!guidance.fixPrompt) return;
    try {
      await navigator.clipboard.writeText(guidance.fixPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard may be unavailable */
    }
  };

  return (
    <section
      style={{
        ...card,
        marginTop: "1.5rem",
        borderColor: colors.warnBorder,
        background: colors.warnBg,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: "1rem", color: colors.warnText }}>{guidance.title}</h3>
        <span
          style={{
            fontSize: "0.72rem",
            fontWeight: 800,
            color: "#061014",
            background: badge.color,
            padding: "0.14rem 0.55rem",
            borderRadius: 999,
          }}
        >
          {badge.label}
        </span>
      </div>

      <p style={{ margin: "0 0 0.75rem", fontSize: "0.88rem", color: colors.warnText, lineHeight: 1.55 }}>
        <strong>What happened:</strong> {guidance.whatHappened}
      </p>

      {guidance.whatYouShouldDo.length > 0 && (
        <>
          <p style={{ margin: "0 0 0.35rem", fontSize: "0.82rem", fontWeight: 700, color: colors.warnText }}>
            What you should do
          </p>
          <ol style={{ margin: "0 0 0.9rem", paddingLeft: "1.2rem", fontSize: "0.86rem", lineHeight: 1.6, color: colors.warnText }}>
            {guidance.whatYouShouldDo.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ol>
        </>
      )}

      {guidance.action === "update_credentials" && onUpdateCredentials && (
        <button type="button" onClick={onUpdateCredentials} style={{ ...buttonStyle("primary"), marginBottom: 12 }}>
          Update {guidance.provider ?? "provider"} credentials
        </button>
      )}

      {guidance.showCursorPrompt && guidance.fixPrompt && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
            <strong style={{ fontSize: "0.82rem", color: colors.warnText }}>
              Paste this into Cursor or ChatGPT to fix the repo:
            </strong>
            <button
              onClick={() => void copy()}
              style={{
                background: "transparent",
                color: colors.accentText,
                border: `1px solid ${colors.border}`,
                borderRadius: 6,
                padding: "0.2rem 0.55rem",
                fontSize: "0.75rem",
                cursor: "pointer",
              }}
            >
              {copied ? "Copied" : "Copy prompt"}
            </button>
          </div>
          <pre
            style={{
              margin: 0,
              padding: "0.6rem 0.7rem",
              background: colors.bg,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              fontSize: "0.74rem",
              fontFamily: mono,
              whiteSpace: "pre-wrap",
              overflowX: "auto",
            }}
          >
            {guidance.fixPrompt}
          </pre>
        </>
      )}

      {!guidance.showCursorPrompt && (
        <p style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", color: colors.warnText, opacity: 0.85 }}>
          No Cursor/ChatGPT code prompt — this is not classified as a repository code bug.
        </p>
      )}
    </section>
  );
}
