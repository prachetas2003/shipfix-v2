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
                width: 22,
                height: 22,
                borderRadius: 999,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.72rem",
                fontWeight: 700,
                color: active ? "#fff" : "#0b0b0b",
                background: color,
              }}
            >
              {done ? "✓" : i + 1}
            </span>
            <span style={{ fontSize: "0.82rem", color: active ? colors.text : colors.dim, fontWeight: active ? 600 : 400 }}>
              {label}
            </span>
            {i < steps.length - 1 && <span style={{ opacity: 0.3, margin: "0 4px" }}>—</span>}
          </div>
        );
      })}
    </div>
  );
}
