"use client";

import { useEffect, useRef, useState } from "react";
import type { RunEventRow } from "../lib/api";
import { translateEvent, type FriendlyTone } from "../lib/logTranslate";
import { Button } from "./ui/Button";
import { colors, mono } from "../lib/theme";

const TONE_COLOR: Record<FriendlyTone, string> = {
  info: colors.dim,
  success: colors.success,
  warn: colors.warn,
  error: colors.error,
  progress: colors.accentText,
};

/** Terminal-style log panel — friendly by default, raw on toggle. */
export function LogDrawer({ events }: { events: RunEventRow[] }): React.ReactElement {
  const [raw, setRaw] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [events.length, raw]);

  if (events.length === 0) {
    return (
      <div className="sf-log-drawer sf-fade-in" style={{ color: colors.dim, textAlign: "center", padding: "2rem 1rem" }}>
        Waiting for log events…
      </div>
    );
  }

  return (
    <div className="sf-slide-up">
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <Button variant="ghost" onClick={() => setRaw((v) => !v)} style={{ padding: "0.35rem 0.7rem", fontSize: "0.78rem" }}>
          {raw ? "Friendly view" : "Technical details"}
        </Button>
      </div>
      <div className="sf-log-drawer">
        {events.map((ev) => {
          const f = translateEvent(ev);
          const color = TONE_COLOR[f.tone];
          if (raw) {
            return (
              <div key={ev.seq} style={{ marginBottom: 8, color: colors.dim }}>
                <span style={{ color }}>[{ev.level}]</span>{" "}
                <span style={{ color: colors.muted }}>{ev.stage ?? ev.type}</span>
                {typeof ev.data?.event === "string" ? ` / ${ev.data.event}` : ""}
                {"\n"}
                {ev.message}
              </div>
            );
          }
          return (
            <div key={ev.seq} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ color, fontWeight: 600 }}>{f.title}</span>
                <span style={{ color: colors.dim, fontSize: "0.7rem" }}>
                  {new Date(ev.createdAt).toLocaleTimeString()}
                </span>
              </div>
              {f.detail && f.detail !== f.title && (
                <div style={{ color: colors.muted, marginTop: 2 }}>{f.detail}</div>
              )}
              {f.url && (
                <a
                  href={f.url.startsWith("http") ? f.url : `https://${f.url}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: colors.accentText, fontFamily: mono, fontSize: "0.72rem", wordBreak: "break-all" }}
                >
                  {f.url}
                </a>
              )}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}
