"use client";

import type { RunEventRow } from "../lib/api";
import { StatusDot } from "./ui/StatusDot";
import { colors } from "../lib/theme";

const STAGES = [
  { id: "queued", label: "Queued" },
  { id: "analyzing", label: "Analyze" },
  { id: "planning", label: "Plan" },
  { id: "provisioning", label: "Provision" },
  { id: "deploying", label: "Deploy" },
  { id: "verifying", label: "Verify" },
  { id: "terminal", label: "Done" },
] as const;

function stageIndex(status: string): number {
  if (["succeeded", "diagnosed", "failed"].includes(status)) return STAGES.length - 1;
  const map: Record<string, number> = {
    queued: 0,
    cloning: 1,
    analyzing: 1,
    planning: 2,
    validating: 2,
    awaiting_input: 2,
    provisioning: 3,
    deploying: 4,
    verifying: 5,
  };
  return map[status] ?? 0;
}

function terminalTone(status: string): "success" | "warn" | "error" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "diagnosed") return "warn";
  if (status === "failed") return "error";
  return "neutral";
}

/** Condensed stage rail — not every raw event. */
export function ActivityStages({
  status,
  events,
}: {
  status: string;
  events: RunEventRow[];
}): React.ReactElement {
  const current = stageIndex(status);
  const terminal = ["succeeded", "diagnosed", "failed"].includes(status);
  const tone = terminalTone(status);

  return (
    <div className="sf-slide-up">
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 0 }}>
        {STAGES.map((stage, i) => {
          const done = i < current || (terminal && i === current);
          const active = !terminal && i === current;
          const isLast = i === STAGES.length - 1;
          const dotTone = isLast && terminal ? tone : done || active ? (active ? "info" : "success") : "neutral";
          return (
            <li
              key={stage.id}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
                padding: "0.55rem 0",
                opacity: done || active ? 1 : 0.45,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 6 }}>
                <StatusDot tone={dotTone} />
                {i < STAGES.length - 1 && (
                  <span
                    style={{
                      width: 1,
                      flex: 1,
                      minHeight: 18,
                      marginTop: 4,
                      background: done ? colors.borderStrong : colors.border,
                    }}
                  />
                )}
              </div>
              <div style={{ flex: 1, paddingBottom: 4 }}>
                <div style={{ fontWeight: active ? 600 : 500, fontSize: "0.9rem" }}>{stage.label}</div>
                {active && (
                  <div style={{ color: colors.dim, fontSize: "0.8rem", marginTop: 2 }}>In progress…</div>
                )}
                {isLast && terminal && (
                  <div style={{ color: colors.dim, fontSize: "0.8rem", marginTop: 2 }}>
                    {status === "succeeded"
                      ? "Verified live"
                      : status === "diagnosed"
                        ? "Needs attention"
                        : "Failed"}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {events.length > 0 && (
        <p style={{ margin: "0.75rem 0 0", color: colors.dim, fontSize: "0.8rem" }}>
          {events.length} timeline events recorded — open Logs for detail.
        </p>
      )}
    </div>
  );
}
