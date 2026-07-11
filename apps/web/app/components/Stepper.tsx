"use client";

import { colors } from "../lib/theme";

export function Stepper({ steps, current }: { steps: string[]; current: number }): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: "1.5rem" }}>
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const color = active ? colors.accent : done ? colors.success : colors.dim;
        return (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: 999,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.7rem",
                fontWeight: 700,
                color: active || done ? "#0a0c10" : colors.dim,
                background: active || done ? color : "transparent",
                border: active || done ? "none" : `1px solid ${colors.borderStrong}`,
                transition: "background 160ms ease, color 160ms ease, border-color 160ms ease",
              }}
            >
              {done ? (
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M2.5 6.5 5 9l4.5-6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                i + 1
              )}
            </span>
            <span
              style={{
                fontSize: "0.84rem",
                color: active ? colors.text : colors.dim,
                fontWeight: active ? 600 : 500,
                transition: "color 160ms ease",
              }}
            >
              {label}
            </span>
            {i < steps.length - 1 && (
              <span
                aria-hidden="true"
                style={{
                  width: 18,
                  height: 1,
                  background: done ? colors.success : colors.border,
                  margin: "0 4px",
                  opacity: done ? 0.7 : 1,
                  transition: "background 160ms ease",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
