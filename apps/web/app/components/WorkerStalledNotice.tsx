"use client";

import { card, colors } from "../lib/theme";

/**
 * Shown when a run sits in "queued" with no timeline events past the stall
 * window — the deployment worker is down or unreachable, and pretending the
 * run is progressing would be dishonest.
 */
export function WorkerStalledNotice({ show }: { show: boolean }): React.ReactElement | null {
  if (!show) return null;
  return (
    <div
      role="alert"
      style={{
        ...card,
        borderColor: colors.warnBorder,
        background: colors.warnBg,
        color: colors.warnText,
        marginTop: "1rem",
      }}
    >
      <strong style={{ display: "block", fontSize: "0.95rem" }}>
        Deployment worker is not running or not reachable.
      </strong>
      <p style={{ margin: "0.45rem 0 0", lineHeight: 1.55, fontSize: "0.88rem", opacity: 0.9 }}>
        The run is queued, but nothing is picking it up. The run will continue automatically
        once the worker is back — no progress was lost.
      </p>
    </div>
  );
}
