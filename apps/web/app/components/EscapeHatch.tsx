"use client";

import { colors } from "../lib/theme";
import { Panel } from "./ui/Panel";

export interface EscapeMoveView {
  id: string;
  title: string;
  automatic: boolean;
  detail: string;
}

export interface EscapePlanView {
  source: "lovable" | "bolt" | "replit";
  platform: string;
  moves: EscapeMoveView[];
}

export function escapeFrom(repoContext: unknown): EscapePlanView | null {
  const escape = (repoContext as { escape?: EscapePlanView } | null)?.escape;
  if (!escape || typeof escape.platform !== "string" || !Array.isArray(escape.moves)) return null;
  return escape;
}

/** What leaves the old host, from files in this commit. The old host is never contacted. */
export function EscapeHatch({ plan }: { plan: EscapePlanView | null }): React.ReactElement | null {
  if (!plan) return null;
  return (
    <Panel className="sf-slide-up" style={{ marginBottom: "0.85rem" }}>
      <strong style={{ fontWeight: 600 }}>Leave {plan.platform}</strong>
      <p style={{ margin: "0.4rem 0 0", color: colors.dim, fontSize: "0.84rem", lineHeight: 1.5 }}>
        ShipFix deploys into the accounts you connect. It does not connect to {plan.platform} to copy live data.
      </p>
      <ul style={{ margin: "0.7rem 0 0", paddingLeft: "1.1rem", display: "grid", gap: 8 }}>
        {plan.moves.map((move) => (
          <li key={move.id} style={{ fontSize: "0.86rem", lineHeight: 1.45 }}>
            <strong>{move.title}</strong>
            <span style={{ color: move.automatic ? colors.success : colors.warn }}>
              {" "}
              · {move.automatic ? "Moves with this deploy" : "Stays until you export it"}
            </span>
            <div style={{ color: colors.muted }}>{move.detail}</div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
