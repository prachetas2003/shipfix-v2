"use client";

import { useEffect, useState } from "react";
import { api, type PlanView } from "../lib/api";
import { buttonStyle, card, colors, h2, mono } from "../lib/theme";

const CLASS_META: Record<PlanView["classification"], { label: string; color: string; explanation: string }> = {
  deployable: {
    label: "Green - ready to deploy",
    color: colors.success,
    explanation: "ShipFix found a supported deployment path. Connect the required providers, then deploy.",
  },
  needs_setup: {
    label: "Yellow - setup needed",
    color: colors.warn,
    explanation:
      "ShipFix found a path, but something still needs setup before provider calls are safe.",
  },
  diagnose_only: {
    label: "Red - diagnosis only",
    color: colors.error,
    explanation:
      "This repo is outside ShipFix alpha support. ShipFix will explain why instead of pretending it can deploy it.",
  },
};

function providerName(provider: string | undefined): string {
  if (provider === "vercel") return "Vercel";
  if (provider === "render") return "Render";
  if (provider === "neon") return "Neon";
  return provider ?? "provider";
}

function serviceType(type: string): string {
  if (type === "frontend_static") return "Frontend app";
  if (type === "node_api") return "Backend API";
  if (type === "worker") return "Worker";
  return type.replace(/_/g, " ");
}

function severityLabel(sev: string): string {
  if (sev === "fatal") return "Blocked";
  if (sev === "needs_input") return "Setup";
  return "Note";
}

function severityColor(sev: string): string {
  if (sev === "fatal") return colors.error;
  if (sev === "needs_input") return colors.warn;
  return colors.dim;
}

function CommandRow({ label, value }: { label: string; value: string | null }): React.ReactElement | null {
  if (!value) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "92px 1fr", gap: 8, marginTop: 5 }}>
      <span style={{ color: colors.dim }}>{label}</span>
      <code style={{ fontFamily: mono, color: colors.muted, wordBreak: "break-all" }}>{value}</code>
    </div>
  );
}

export function PlanPanel({
  plan,
  runId,
  answeredQuestionIds = [],
  onAnswersSaved,
}: {
  plan: PlanView;
  runId?: string;
  answeredQuestionIds?: string[];
  onAnswersSaved?: (answered: string[]) => void;
}): React.ReactElement {
  const meta = CLASS_META[plan.classification];
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<string[]>(answeredQuestionIds);

  useEffect(() => {
    setSavedIds(answeredQuestionIds);
  }, [answeredQuestionIds]);

  const unanswered = plan.questions.filter((q) => !savedIds.includes(q.id));
  const canSubmit =
    Boolean(runId) &&
    unanswered.length > 0 &&
    unanswered.every((q) => (drafts[q.id] ?? "").trim().length > 0);

  async function submitAnswers(): Promise<void> {
    if (!runId || !canSubmit) return;
    setSaving(true);
    setSaveError(null);
    try {
      const answers = unanswered.map((q) => ({
        questionId: q.id,
        value: (drafts[q.id] ?? "").trim(),
      }));
      const result = await api.submitRunInputs(runId, answers);
      setSavedIds((prev) => [...new Set([...prev, ...result.answered])]);
      setDrafts({});
      onAnswersSaved?.(result.answered);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={{ marginTop: "2rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: "0.75rem", flexWrap: "wrap" }}>
        <h2 style={h2}>Deployment plan</h2>
        <span
          style={{
            fontSize: "0.72rem",
            fontWeight: 800,
            color: "#061014",
            background: meta.color,
            padding: "0.18rem 0.6rem",
            borderRadius: 999,
          }}
        >
          {meta.label}
        </span>
        <span style={{ fontSize: "0.8rem", color: colors.dim }}>
          confidence {(plan.confidence * 100).toFixed(0)}%
        </span>
      </div>

      <div style={{ ...card, background: colors.panelSoft }}>
        <p style={{ margin: 0, color: colors.text, fontWeight: 700 }}>{plan.goal}</p>
        <p style={{ margin: "0.45rem 0 0", fontSize: "0.86rem", color: meta.color, lineHeight: 1.55 }}>
          {meta.explanation}
        </p>
      </div>

      {plan.questions.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h3 style={{ ...h2, fontSize: "0.75rem" }}>Setup answers</h3>
          {plan.questions.map((q) => {
            const answered = savedIds.includes(q.id);
            const isSecret = q.kind === "secret";
            return (
              <div key={q.id} style={{ ...card, marginTop: 8, fontSize: "0.86rem" }}>
                <strong>{q.prompt}</strong>
                {q.options && q.options.length > 0 && (
                  <p style={{ margin: "0.35rem 0 0", color: colors.dim }}>
                    Options: {q.options.join(", ")}
                  </p>
                )}
                {answered ? (
                  <p style={{ margin: "0.55rem 0 0", color: colors.successText, fontWeight: 700 }}>
                    Saved{isSecret ? " (secret sealed)" : ""}
                  </p>
                ) : runId ? (
                  <input
                    type={isSecret ? "password" : "text"}
                    autoComplete="off"
                    placeholder={isSecret ? "Enter secret value" : "Enter answer"}
                    value={drafts[q.id] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
                    style={{
                      marginTop: 10,
                      width: "100%",
                      boxSizing: "border-box",
                      background: colors.panelSoft,
                      border: `1px solid ${colors.border}`,
                      borderRadius: 8,
                      color: colors.text,
                      padding: "0.55rem 0.7rem",
                      fontFamily: mono,
                    }}
                  />
                ) : (
                  <p style={{ margin: "0.55rem 0 0", color: colors.dim }}>
                    Answer this after the plan run is ready.
                  </p>
                )}
              </div>
            );
          })}
          {runId && unanswered.length > 0 && (
            <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                disabled={!canSubmit || saving}
                onClick={() => void submitAnswers()}
                style={buttonStyle(canSubmit && !saving ? "primary" : "ghost")}
              >
                {saving ? "Saving…" : "Save answers"}
              </button>
              {saveError && <span style={{ color: colors.errorText, fontSize: "0.85rem" }}>{saveError}</span>}
            </div>
          )}
        </div>
      )}

      {plan.blockers.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h3 style={{ ...h2, fontSize: "0.75rem" }}>Needs attention</h3>
          {plan.blockers.map((b, i) => (
            <div key={i} style={{ ...card, marginTop: 8, borderLeft: `4px solid ${severityColor(b.severity)}` }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ color: severityColor(b.severity), fontWeight: 800, fontSize: "0.72rem" }}>
                  {severityLabel(b.severity)}
                </span>
                <strong style={{ fontSize: "0.92rem" }}>{b.title}</strong>
              </div>
              <p style={{ margin: "0.4rem 0 0.25rem", fontSize: "0.85rem", color: colors.muted, lineHeight: 1.5 }}>{b.explanation}</p>
              <p style={{ margin: 0, fontSize: "0.82rem", color: colors.dim }}>Next: {b.action}</p>
            </div>
          ))}
        </div>
      )}

      {plan.services.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h3 style={{ ...h2, fontSize: "0.75rem" }}>Services ShipFix will deploy</h3>
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            {plan.services.map((s) => (
              <div key={s.id} style={{ ...card, fontSize: "0.85rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong>{serviceType(s.type)}</strong>
                  <span style={{ color: colors.dim }}>to {providerName(s.provider)}</span>
                  <code style={{ fontFamily: mono, color: colors.dim }}>{s.rootDir || "/"}</code>
                </div>
                <CommandRow label="Install" value={s.install} />
                <CommandRow label="Build" value={s.build} />
                <CommandRow label="Start" value={s.start} />
                <CommandRow label="Health" value={s.healthCheckPath} />
                {s.env.length > 0 && (
                  <p style={{ margin: "0.55rem 0 0", color: colors.dim, fontSize: "0.82rem", lineHeight: 1.5 }}>
                    Env ShipFix will set:{" "}
                    {s.env.map((e) => (
                      <code key={e.name} style={{ marginRight: 8, fontFamily: mono, color: colors.muted }}>
                        {e.name}
                      </code>
                    ))}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {plan.managed.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h3 style={{ ...h2, fontSize: "0.75rem" }}>Managed infrastructure</h3>
          {plan.managed.map((m) => (
            <div key={m.id} style={{ ...card, marginTop: 8, fontSize: "0.85rem" }}>
              <strong>{m.kind === "postgres" ? "Postgres database" : m.kind}</strong>{" "}
              <span style={{ color: colors.dim }}>
                on {providerName(m.provider)}. Exposes <code style={{ fontFamily: mono }}>{m.exposesEnv}</code> to the backend.
              </span>
            </div>
          ))}
        </div>
      )}

      {plan.wiring.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h3 style={{ ...h2, fontSize: "0.75rem" }}>Automatic wiring</h3>
          <div style={{ ...card, fontSize: "0.85rem" }}>
            {plan.wiring.map((w, i) => (
              <div key={i} style={{ color: colors.muted, lineHeight: 1.7 }}>
                <code style={{ fontFamily: mono }}>
                  {w.fromServiceId}.{w.fromField}
                </code>{" "}
                -&gt;{" "}
                <code style={{ fontFamily: mono }}>
                  {w.toServiceId}.{w.toEnvName}
                </code>
              </div>
            ))}
          </div>
        </div>
      )}

      {plan.deployOrder.length > 0 && (
        <p style={{ marginTop: "1rem", fontSize: "0.85rem", color: colors.dim }}>
          Deploy order:{" "}
          {plan.deployOrder.map((id) => (
            <code key={id} style={{ marginRight: 6, fontFamily: mono, color: colors.muted }}>
              {id}
            </code>
          ))}
        </p>
      )}
    </section>
  );
}
