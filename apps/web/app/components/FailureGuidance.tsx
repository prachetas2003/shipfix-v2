"use client";

import { useState } from "react";
import type { RunEventRow } from "../lib/api";
import { Button } from "./ui/Button";
import { colors, mono } from "../lib/theme";

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
    // A pushed fix supersedes earlier guidance; a newer failure would come after it.
    if (d.event === "repair_pushed" || d.event === "question") return null;
    if (d.event === "repair_push_unavailable" && typeof d.fixPrompt === "string") {
      return {
        action: "fix_repo_code",
        title: "ShipFix found and tested a fix",
        whatHappened: ev.message,
        whatYouShouldDo: [
          "Apply the change below (paste it into Cursor, or edit the files yourself).",
          "Commit and push to your main branch.",
          "Deploy again from ShipFix.",
        ],
        showCursorPrompt: true,
        fixPrompt: d.fixPrompt,
        provider: null,
        serviceId: null,
      };
    }
    if (d.event === "deploy_failure_guidance") {
      const action = String(d.action ?? "inspect_error") as GuidanceAction;
      return withVercelGithubSetup({
        action,
        title: typeof d.title === "string" ? d.title : "What to do next",
        whatHappened: typeof d.whatHappened === "string" ? d.whatHappened : ev.message,
        whatYouShouldDo: asStringArray(d.whatYouShouldDo),
        showCursorPrompt: Boolean(d.showCursorPrompt),
        fixPrompt: typeof d.fixPrompt === "string" ? d.fixPrompt : null,
        provider: typeof d.provider === "string" ? d.provider : null,
        serviceId: typeof d.serviceId === "string" ? d.serviceId : null,
      });
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

const VERCEL_GITHUB_STEPS = [
  "Open Vercel login connections and add GitHub on the same account as the token: https://vercel.com/account/login-connections",
  "Sign in to GitHub. Open https://github.com/settings/installations. Click Vercel, then Configure. Include this repository and press Save. The button is Configure. If the page says Sign in, press Sign in first.",
  "Come back to ShipFix and press Deploy again.",
];

function withVercelGithubSetup(guidance: FailureGuidanceData): FailureGuidanceData {
  const blob = `${guidance.title} ${guidance.whatHappened} ${guidance.whatYouShouldDo.join(" ")}`;
  if (!/install the GitHub integration|GitHub integration first|Login Connection|Vercel GitHub app required|Vercel GitHub connection required/i.test(blob)) {
    return guidance;
  }
  return {
    ...guidance,
    action: "fix_account_setup",
    title: "Connect Vercel to GitHub",
    whatYouShouldDo: VERCEL_GITHUB_STEPS,
    showCursorPrompt: false,
    fixPrompt: null,
  };
}

function linkify(text: string): React.ReactNode {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, index) => {
    if (!part.startsWith("http")) return <span key={index}>{part}</span>;
    const url = part.replace(/[.,)]$/, "");
    return (
      <a key={index} href={url} target="_blank" rel="noreferrer" style={{ color: colors.accentText, fontWeight: 600 }}>
        {url}
      </a>
    );
  });
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
  const shown = guidance ? withVercelGithubSetup(guidance) : null;
  if (!shown) return null;

  const badge = actionBadge(shown.action);
  const copy = async () => {
    if (!shown.fixPrompt) return;
    try {
      await navigator.clipboard.writeText(shown.fixPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard may be unavailable */
    }
  };

  return (
    <section className="sf-panel sf-slide-up" style={{ marginTop: "1.25rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600, color: colors.warnText }}>{shown.title}</h3>
        <span className={`sf-badge sf-badge--${shown.action === "fix_repo_code" ? "warn" : "info"}`}>
          {badge.label}
        </span>
      </div>

      <p style={{ margin: "0 0 0.75rem", fontSize: "0.88rem", color: colors.warnText, lineHeight: 1.55 }}>
        <strong>What happened:</strong> {shown.whatHappened}
      </p>

      {shown.whatYouShouldDo.length > 0 && (
        <>
          <p style={{ margin: "0 0 0.35rem", fontSize: "0.82rem", fontWeight: 700, color: colors.warnText }}>
            What you should do
          </p>
          <ol style={{ margin: "0 0 0.9rem", paddingLeft: "1.2rem", fontSize: "0.86rem", lineHeight: 1.6, color: colors.warnText }}>
            {shown.whatYouShouldDo.map((item, i) => (
              <li key={i}>{linkify(item)}</li>
            ))}
          </ol>
        </>
      )}

      {shown.action === "update_credentials" && onUpdateCredentials && (
        <Button onClick={onUpdateCredentials} style={{ marginBottom: 12 }}>
          Update {shown.provider ?? "provider"} credentials
        </Button>
      )}

      {shown.showCursorPrompt && shown.fixPrompt && (
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
            {shown.fixPrompt}
          </pre>
        </>
      )}

      {shown.action === "inspect_error" && (
        <p style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", color: colors.warnText, opacity: 0.85 }}>
          Open the provider log before changing the repository.
        </p>
      )}
    </section>
  );
}
