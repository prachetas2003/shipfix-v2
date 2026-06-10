"use client";

import { useState } from "react";
import type { RunEventRow } from "../lib/api";
import { translateEvent, type FriendlyTone } from "../lib/logTranslate";
import { card, colors, h2, mono } from "../lib/theme";

const TONE_COLOR: Record<FriendlyTone, string> = {
  info: colors.dim,
  success: colors.success,
  warn: colors.warn,
  error: colors.error,
  progress: colors.accentText,
};

const TONE_LABEL: Record<FriendlyTone, string> = {
  info: "i",
  success: "OK",
  warn: "!",
  error: "X",
  progress: "...",
};

/** Beginner-readable timeline: friendly summary per event, raw details on demand. */
export function Timeline({ events }: { events: RunEventRow[] }): React.ReactElement | null {
  const [showTech, setShowTech] = useState(false);
  if (events.length === 0) return null;

  return (
    <section style={{ marginTop: "2rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: "0.85rem", flexWrap: "wrap" }}>
        <div>
          <h2 style={h2}>Timeline</h2>
          <p style={{ margin: "0.35rem 0 0", color: colors.dim, fontSize: "0.84rem" }}>
            Human-readable deployment events. Raw provider output stays under technical details.
          </p>
        </div>
        <button
          onClick={() => setShowTech((v) => !v)}
          style={{
            background: colors.panel,
            color: colors.text,
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: 8,
            padding: "0.4rem 0.7rem",
            fontSize: "0.78rem",
            cursor: "pointer",
          }}
        >
          {showTech ? "Hide technical details" : "Show technical details"}
        </button>
      </div>
      <ol style={{ listStyle: "none", padding: 0, margin: 0, border: `1px solid ${colors.border}`, borderRadius: 8, overflow: "hidden" }}>
        {events.map((ev) => {
          const f = translateEvent(ev);
          const color = TONE_COLOR[f.tone];
          return (
            <li
              key={ev.seq}
              style={{
                display: "flex",
                gap: 12,
                padding: "0.85rem 1rem",
                borderBottom: `1px solid ${colors.border}`,
                background: f.tone === "error" ? colors.errorBg : f.tone === "warn" ? colors.warnBg : colors.card,
              }}
            >
              <span
                style={{
                  color,
                  border: `1px solid ${color}`,
                  minWidth: 28,
                  height: 28,
                  borderRadius: 999,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 800,
                  fontSize: "0.68rem",
                }}
              >
                {TONE_LABEL[f.tone]}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ color, fontWeight: 800, fontSize: "0.94rem" }}>{f.title}</div>
                  <span style={{ color: colors.dim, fontSize: "0.72rem" }}>{new Date(ev.createdAt).toLocaleTimeString()}</span>
                </div>
                {f.detail && f.detail !== f.title && (
                  <div style={{ color: colors.muted, fontSize: "0.85rem", marginTop: 3, lineHeight: 1.5 }}>{f.detail}</div>
                )}
                {f.url && (
                  <a
                    href={f.url.startsWith("http") ? f.url : `https://${f.url}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: colors.accentText, fontFamily: mono, fontSize: "0.8rem", wordBreak: "break-all" }}
                  >
                    {f.url}
                  </a>
                )}
                {showTech && (
                  <pre
                    style={{
                      ...card,
                      marginTop: 8,
                      padding: "0.65rem 0.75rem",
                      fontSize: "0.72rem",
                      color: colors.dim,
                      overflowX: "auto",
                      whiteSpace: "pre-wrap",
                      boxShadow: "none",
                    }}
                  >
                    [{ev.level}] {ev.stage ?? ev.type}
                    {typeof ev.data?.event === "string" ? ` / ${ev.data.event}` : ""}
                    {"\n"}
                    {ev.message}
                  </pre>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
