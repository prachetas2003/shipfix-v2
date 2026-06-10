"use client";

import { useState } from "react";
import { api } from "../lib/api";
import { ENCRYPTION_NOTE, providerGuide, type ProviderId } from "../lib/providerGuide";
import { buttonStyle, card, colors, inputStyle, mono } from "../lib/theme";

/**
 * Guided credential card for a single provider: explains what the key is for,
 * links to token setup, surfaces required provider-specific steps, and reassures
 * the user that secrets stay backend-only.
 */
export function ConnectProvider({
  providerId,
  connected,
  reason,
  onConnected,
}: {
  providerId: ProviderId;
  connected: boolean;
  reason?: string;
  onConnected?: () => void;
}): React.ReactElement | null {
  const guide = providerGuide(providerId);
  const [value, setValue] = useState("");
  const [optionalValues, setOptionalValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!guide) return null;

  const connect = async () => {
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      await api.connectProvider(guide.id, {
        [guide.credentialField]: value,
        ...optionalValues,
      });
      setValue("");
      setOptionalValues({});
      setMsg(`${guide.name} connected.`);
      onConnected?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        ...card,
        marginBottom: 12,
        borderColor: connected ? colors.successDeep : colors.borderStrong,
        background: connected ? "rgba(5,46,31,0.38)" : colors.card,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 420px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: "1rem" }}>{guide.name}</strong>
            <span style={{ color: colors.dim, fontSize: "0.82rem" }}>{guide.blurb}</span>
          </div>
          {reason && <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", color: colors.muted }}>{reason}</p>}
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", color: colors.dim, lineHeight: 1.55 }}>{guide.whatFor}</p>
        </div>
        <span
          style={{
            fontSize: "0.72rem",
            fontWeight: 800,
            color: "#061014",
            background: connected ? colors.success : colors.warn,
            padding: "0.18rem 0.6rem",
            borderRadius: 999,
          }}
        >
          {connected ? "Ready" : "Setup needed"}
        </span>
      </div>

      {!connected && (
        <>
          <div style={{ marginTop: "0.8rem", borderTop: `1px solid ${colors.border}`, paddingTop: "0.8rem" }}>
            <p style={{ margin: 0, fontSize: "0.85rem", color: colors.muted, lineHeight: 1.6 }}>
              Create an account-level {guide.credentialLabel.toLowerCase()} at{" "}
              <a href={guide.tokenUrl} target="_blank" rel="noreferrer" style={{ color: colors.accentText, fontWeight: 700 }}>
                {guide.tokenUrlLabel}
              </a>
              . {guide.scope}
            </p>
          </div>

          {guide.extraSteps?.map((step) => (
            <div
              key={step.title}
              style={{ marginTop: 10, padding: "0.75rem", background: colors.warnBg, border: `1px solid ${colors.warnBorder}`, borderRadius: 8 }}
            >
              <strong style={{ fontSize: "0.85rem", color: colors.warnText }}>{step.title}</strong>
              <p style={{ margin: "0.3rem 0 0", fontSize: "0.82rem", color: colors.warnText, opacity: 0.92, lineHeight: 1.5 }}>{step.detail}</p>
              {step.url && (
                <a href={step.url} target="_blank" rel="noreferrer" style={{ color: colors.accentText, fontSize: "0.82rem" }}>
                  {step.urlLabel ?? step.url}
                </a>
              )}
            </div>
          ))}

          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={`${guide.name} ${guide.credentialLabel}`}
              type="password"
              spellCheck={false}
              style={{ ...inputStyle, flex: 1, minWidth: 220, fontFamily: mono, padding: "0.55rem 0.75rem" }}
            />
            {guide.optionalFields?.map((field) => (
              <input
                key={field.field}
                value={optionalValues[field.field] ?? ""}
                onChange={(e) =>
                  setOptionalValues((prev) => ({ ...prev, [field.field]: e.target.value }))
                }
                placeholder={field.placeholder}
                spellCheck={false}
                style={{ ...inputStyle, flex: 1, minWidth: 220, fontFamily: mono, padding: "0.55rem 0.75rem" }}
                aria-label={`${guide.name} ${field.label}`}
              />
            ))}
            <button
              onClick={() => void connect()}
              disabled={saving || value.trim().length === 0}
              style={buttonStyle("primary", saving || value.trim().length === 0)}
            >
              {saving ? "Connecting..." : `Connect ${guide.name}`}
            </button>
          </div>
          <p style={{ margin: "0.55rem 0 0", fontSize: "0.76rem", color: colors.dim, lineHeight: 1.45 }}>{ENCRYPTION_NOTE}</p>
        </>
      )}

      {guide.lifecycle && (
        <p style={{ margin: "0.65rem 0 0", fontSize: "0.78rem", color: colors.dim, lineHeight: 1.45 }}>Note: {guide.lifecycle}</p>
      )}

      {msg && <p style={{ margin: "0.55rem 0 0", color: colors.success, fontSize: "0.82rem" }}>{msg}</p>}
      {err && <p style={{ margin: "0.55rem 0 0", color: colors.error, fontSize: "0.82rem" }}>{err}</p>}
    </div>
  );
}
