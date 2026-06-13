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
                width: 26,
                height: 26,
                borderRadius: 999,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.72rem",
                fontWeight: 800,
                color: active ? "#fff" : done ? "#04120c" : "#061014",
                background: color,
                boxShadow: active ? "0 0 0 4px rgba(14,165,233,0.18)" : "none",
                transition: "background 160ms ease, box-shadow 160ms ease",
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
            <span style={{ fontSize: "0.84rem", color: active ? colors.text : colors.dim, fontWeight: active ? 700 : 500 }}>
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
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
