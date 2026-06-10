"use client";

import { useState } from "react";
import type { RunEventRow } from "../lib/api";
import { card, colors, mono } from "../lib/theme";

interface Guidance {
  serviceId: string | null;
  stage: string | null;
  summary: string;
  checklist: string[];
  fixPrompt: string;
}

function extractGuidance(events: RunEventRow[]): Guidance | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.data?.event !== "deploy_fix_guidance") continue;
    const d = ev.data as Record<string, unknown>;
    const checklist = Array.isArray(d.checklist) ? d.checklist.map(String) : [];
    const fixPrompt = typeof d.fixPrompt === "string" ? d.fixPrompt : "";
    if (!fixPrompt) return null;
    return {
      serviceId: typeof d.serviceId === "string" ? d.serviceId : null,
      stage: typeof d.stage === "string" ? d.stage : null,
      summary: ev.message,
      checklist,
      fixPrompt,
    };
  }
  return null;
}

/**
 * When a deploy fails because of the repo's own code/config, ShipFix shows what
 * to fix: a manual checklist plus a copy-pasteable prompt for Cursor/ChatGPT.
 * ShipFix never edits the repo; the user fixes it and reruns deploy.
 */
export function FixGuidance({ events }: { events: RunEventRow[] }): React.ReactElement | null {
  const [copied, setCopied] = useState(false);
  const guidance = extractGuidance(events);
  if (!guidance) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(guidance.fixPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard may be unavailable; the prompt is still visible below */
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
      <h3 style={{ margin: "0 0 0.35rem", fontSize: "1rem", color: colors.warnText }}>
        How to fix this repo
        {guidance.stage ? ` (${guidance.stage} stage)` : ""}
      </h3>
      <p style={{ margin: "0 0 0.75rem", fontSize: "0.88rem", color: colors.warnText, lineHeight: 1.55 }}>
        {guidance.summary} ShipFix does not edit your code. Fix it below and rerun deploy.
      </p>

      {guidance.checklist.length > 0 && (
        <ol style={{ margin: "0 0 0.9rem", paddingLeft: "1.2rem", fontSize: "0.86rem", lineHeight: 1.6 }}>
          {guidance.checklist.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
        <strong style={{ fontSize: "0.82rem" }}>Copy this prompt into Cursor or ChatGPT:</strong>
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
    </section>
  );
}
