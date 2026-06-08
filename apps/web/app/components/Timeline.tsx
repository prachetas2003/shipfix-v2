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

const TONE_DOT: Record<FriendlyTone, string> = {
  info: "•",
  success: "✓",
  warn: "!",
  error: "✕",
  progress: "…",
};

/** Beginner-readable timeline: friendly summary per event, raw details on demand. */
export function Timeline({ events }: { events: RunEventRow[] }): React.ReactElement | null {
  const [showTech, setShowTech] = useState(false);
  if (events.length === 0) return null;

  return (
    <section style={{ marginTop: "2rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
        <h2 style={h2}>What's happening</h2>
        <button
          onClick={() => setShowTech((v) => !v)}
          style={{
            background: "transparent",
            color: colors.dim,
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            padding: "0.25rem 0.6rem",
            fontSize: "0.75rem",
            cursor: "pointer",
          }}
        >
          {showTech ? "Hide technical details" : "Show technical details"}
        </button>
      </div>
      <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {events.map((ev) => {
          const f = translateEvent(ev);
          const color = TONE_COLOR[f.tone];
          return (
            <li
              key={ev.seq}
              style={{
                display: "flex",
                gap: 12,
                padding: "0.55rem 0",
                borderBottom: `1px solid ${colors.border}`,
              }}
            >
              <span style={{ color, minWidth: 16, textAlign: "center", fontWeight: 700 }}>
                {TONE_DOT[f.tone]}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ color, fontWeight: 600, fontSize: "0.92rem" }}>{f.title}</div>
                {f.detail && f.detail !== f.title && (
                  <div style={{ opacity: 0.75, fontSize: "0.85rem", marginTop: 2 }}>{f.detail}</div>
                )}
                {f.url && (
                  <a
                    href={f.url.startsWith("http") ? f.url : `https://${f.url}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: colors.accentText, fontFamily: mono, fontSize: "0.8rem" }}
                  >
                    {f.url}
                  </a>
                )}
                {showTech && (
                  <pre
                    style={{
                      ...card,
                      marginTop: 6,
                      padding: "0.5rem 0.7rem",
                      fontSize: "0.72rem",
                      opacity: 0.7,
                      overflowX: "auto",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    [{ev.level}] {ev.stage ?? ev.type}
                    {typeof ev.data?.event === "string" ? ` · ${ev.data.event}` : ""}
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
