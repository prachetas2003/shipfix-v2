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
                fontSize: done ? "0.58rem" : "0.72rem",
                fontWeight: 800,
                color: active ? "#fff" : "#061014",
                background: color,
              }}
            >
              {done ? "OK" : i + 1}
            </span>
            <span style={{ fontSize: "0.84rem", color: active ? colors.text : colors.dim, fontWeight: active ? 700 : 500 }}>
              {label}
            </span>
            {i < steps.length - 1 && <span style={{ opacity: 0.35, margin: "0 4px" }}>-</span>}
          </div>
        );
      })}
    </div>
  );
}
