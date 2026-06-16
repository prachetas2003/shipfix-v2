"use client";

import { card, colors } from "../lib/theme";

/**
 * Shown when the worker picked up a Temporal task but could not find the run row
 * in its database — almost always an API/worker DATABASE_URL mismatch.
 */
export function ControlPlaneConsistencyNotice({ show }: { show: boolean }): React.ReactElement | null {
  if (!show) return null;
  return (
    <div
      role="alert"
      style={{
        ...card,
        borderColor: colors.errorBorder,
        background: colors.errorBg,
        color: colors.errorText,
        marginTop: "1rem",
      }}
    >
      <strong style={{ display: "block", fontSize: "0.95rem" }}>
        ShipFix started a worker task, but the worker could not find the run record.
      </strong>
      <p style={{ margin: "0.45rem 0 0", lineHeight: 1.55, fontSize: "0.88rem", opacity: 0.9 }}>
        This usually means API and worker are connected to different databases. After changing{" "}
        <code>DATABASE_URL</code>, restart the API, worker, web app, and Temporal together. Do not mix
        local Docker Postgres and Neon in one test session — old Temporal workflows may still reference
        runs in a previous database.
      </p>
    </div>
  );
}
