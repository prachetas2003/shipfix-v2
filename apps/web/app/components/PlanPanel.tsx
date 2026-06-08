"use client";

import { Fragment } from "react";
import type { PlanView } from "../lib/api";
import { card, colors, h2 } from "../lib/theme";

const CLASS_META: Record<PlanView["classification"], { label: string; color: string; explanation: string }> = {
  deployable: {
    label: "Green · Deployable",
    color: colors.success,
    explanation: "ShipFix can auto-deploy this once the required providers are connected.",
  },
  needs_setup: {
    label: "Yellow · Needs setup",
    color: colors.warn,
    explanation:
      "Almost there — finish the setup items below (secrets, connections, migrations) and re-analyze, then deploy.",
  },
  diagnose_only: {
    label: "Red · Diagnosis only",
    color: colors.error,
    explanation:
      "ShipFix can't safely auto-deploy this app yet. It's outside the supported slice, so this is a diagnosis with next steps — not a deploy.",
  },
};

function severityColor(sev: string): string {
  if (sev === "fatal") return colors.error;
  if (sev === "needs_input") return colors.warn;
  return colors.dim;
}

function Dl({ rows }: { rows: Array<[string, string | null]> }) {
  const present = rows.filter(([, v]) => v != null && v !== "");
  if (present.length === 0) return null;
  return (
    <div style={{ marginTop: 6, display: "grid", gridTemplateColumns: "max-content 1fr", gap: "2px 10px" }}>
      {present.map(([k, v]) => (
        <Fragment key={k}>
          <span style={{ opacity: 0.5 }}>{k}</span>
          <code>{v}</code>
        </Fragment>
      ))}
    </div>
  );
}

export function PlanPanel({ plan }: { plan: PlanView }): React.ReactElement {
  const meta = CLASS_META[plan.classification];

  return (
    <section style={{ marginTop: "2rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: "0.75rem" }}>
        <h2 style={h2}>Deployment plan</h2>
        <span
          style={{
            fontSize: "0.72rem",
            fontWeight: 700,
            color: "#0b0b0b",
            background: meta.color,
            padding: "0.15rem 0.55rem",
            borderRadius: 999,
          }}
        >
          {meta.label}
        </span>
        <span style={{ fontSize: "0.8rem", opacity: 0.6 }}>
          confidence {(plan.confidence * 100).toFixed(0)}%
        </span>
      </div>

      <p style={{ marginTop: 0, opacity: 0.85 }}>{plan.goal}</p>

      <p
        style={{
          margin: "0 0 0.5rem",
          fontSize: "0.84rem",
          color: meta.color,
          opacity: 0.95,
        }}
      >
        {meta.explanation}
      </p>

      {plan.questions.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h3 style={{ ...h2, fontSize: "0.75rem" }}>Setup checklist</h3>
          {plan.questions.map((q) => (
            <div key={q.id} style={{ ...card, marginBottom: 8, fontSize: "0.85rem" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ color: colors.warn, fontWeight: 700, fontSize: "0.72rem" }}>
                  {q.kind === "secret" ? "SECRET" : q.kind === "choice" ? "CHOICE" : "CONFIRM"}
                </span>
                <strong>{q.prompt}</strong>
              </div>
              {q.options && q.options.length > 0 && (
                <p style={{ margin: "0.35rem 0 0", opacity: 0.7 }}>
                  Options: {q.options.join(", ")}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {plan.blockers.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h3 style={{ ...h2, fontSize: "0.75rem" }}>Blockers</h3>
          {plan.blockers.map((b, i) => (
            <div key={i} style={{ ...card, marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ color: severityColor(b.severity), fontWeight: 700, fontSize: "0.72rem" }}>
                  {b.severity.toUpperCase()}
                </span>
                <strong style={{ fontSize: "0.9rem" }}>{b.title}</strong>
              </div>
              <p style={{ margin: "0.4rem 0 0.2rem", fontSize: "0.85rem", opacity: 0.85 }}>{b.explanation}</p>
              <p style={{ margin: 0, fontSize: "0.82rem", opacity: 0.7 }}>→ {b.action}</p>
            </div>
          ))}
        </div>
      )}

      {plan.services.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h3 style={{ ...h2, fontSize: "0.75rem" }}>Services</h3>
          {plan.services.map((s) => (
            <div key={s.id} style={{ ...card, marginBottom: 8, fontSize: "0.85rem" }}>
              <div>
                <strong>{s.id}</strong>{" "}
                <span style={{ opacity: 0.6 }}>
                  {s.type} · {s.provider} · <code>{s.rootDir || "/"}</code>
                </span>
              </div>
              <Dl
                rows={[
                  ["install", s.install],
                  ["build", s.build],
                  ["start", s.start],
                  ["outputDir", s.outputDir],
                  ["healthCheck", s.healthCheckPath],
                ]}
              />
              {s.env.length > 0 && (
                <div style={{ marginTop: 6, opacity: 0.85 }}>
                  env:{" "}
                  {s.env.map((e) => (
                    <code key={e.name} style={{ marginRight: 8 }}>
                      {e.name}={e.source}
                      {e.ref ? `(${e.ref})` : ""}
                    </code>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {plan.managed.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h3 style={{ ...h2, fontSize: "0.75rem" }}>Managed services</h3>
          {plan.managed.map((m) => (
            <div key={m.id} style={{ ...card, marginBottom: 8, fontSize: "0.85rem" }}>
              <strong>{m.id}</strong>{" "}
              <span style={{ opacity: 0.6 }}>
                {m.kind} · {m.mode}
                {m.provider ? ` · ${m.provider}` : ""} · exposes <code>{m.exposesEnv}</code> · migration {m.migration}
              </span>
            </div>
          ))}
        </div>
      )}

      {plan.wiring.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h3 style={{ ...h2, fontSize: "0.75rem" }}>Wiring</h3>
          <div style={{ ...card, fontSize: "0.85rem" }}>
            {plan.wiring.map((w, i) => (
              <div key={i}>
                <code>
                  {w.fromServiceId}.{w.fromField}
                </code>{" "}
                →{" "}
                <code>
                  {w.toServiceId}.{w.toEnvName}
                </code>
              </div>
            ))}
          </div>
        </div>
      )}

      {plan.deployOrder.length > 0 && (
        <p style={{ marginTop: "1rem", fontSize: "0.85rem", opacity: 0.7 }}>
          deploy order:{" "}
          {plan.deployOrder.map((id) => (
            <code key={id} style={{ marginRight: 6 }}>
              {id}
            </code>
          ))}
        </p>
      )}
    </section>
  );
}
