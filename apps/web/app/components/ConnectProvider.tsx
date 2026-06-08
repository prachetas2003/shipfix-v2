"use client";

import { useState } from "react";
import { api } from "../lib/api";
import { ENCRYPTION_NOTE, providerGuide, type ProviderId } from "../lib/providerGuide";
import { buttonStyle, card, colors, inputStyle, mono } from "../lib/theme";

/**
 * Guided credential card for a single provider: explains what the key is for,
 * links straight to the token page, lists required scope and lifecycle quirks,
 * surfaces extra setup (Vercel<->GitHub), and reassures about encryption.
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
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <strong style={{ fontSize: "1rem" }}>{guide.name}</strong>
        <span style={{ opacity: 0.6, fontSize: "0.82rem" }}>{guide.blurb}</span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: "0.72rem",
            fontWeight: 700,
            color: "#0b0b0b",
            background: connected ? colors.success : colors.warn,
            padding: "0.12rem 0.55rem",
            borderRadius: 999,
          }}
        >
          {connected ? "Connected" : "Not connected"}
        </span>
      </div>

      {reason && <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", opacity: 0.85 }}>{reason}</p>}
      <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", opacity: 0.8 }}>{guide.whatFor}</p>

      {!connected && (
        <>
          <ol style={{ margin: "0.7rem 0 0", paddingLeft: "1.2rem", fontSize: "0.85rem", opacity: 0.9, lineHeight: 1.7 }}>
            <li>
              Create a {guide.credentialLabel} at{" "}
              <a href={guide.tokenUrl} target="_blank" rel="noreferrer" style={{ color: colors.accentText }}>
                {guide.tokenUrlLabel}
              </a>
              . <span style={{ opacity: 0.7 }}>{guide.scope}</span>
            </li>
            <li>Paste it below and connect.</li>
          </ol>

          {guide.extraSteps?.map((step) => (
            <div
              key={step.title}
              style={{ ...card, marginTop: 8, background: colors.warnBg, borderColor: colors.warnBorder }}
            >
              <strong style={{ fontSize: "0.85rem", color: colors.warnText }}>{step.title}</strong>
              <p style={{ margin: "0.3rem 0 0", fontSize: "0.82rem", opacity: 0.9 }}>{step.detail}</p>
              {step.url && (
                <a href={step.url} target="_blank" rel="noreferrer" style={{ color: colors.accentText, fontSize: "0.82rem" }}>
                  {step.urlLabel ?? step.url}
                </a>
              )}
            </div>
          ))}

          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={`${guide.name} ${guide.credentialLabel}`}
              type="password"
              spellCheck={false}
              style={{ ...inputStyle, flex: 1, minWidth: 220, fontFamily: mono, padding: "0.5rem 0.7rem" }}
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
                style={{ ...inputStyle, flex: 1, minWidth: 220, fontFamily: mono, padding: "0.5rem 0.7rem" }}
                aria-label={`${guide.name} ${field.label}`}
              />
            ))}
            <button
              onClick={() => void connect()}
              disabled={saving || value.trim().length === 0}
              style={buttonStyle("ghost", saving || value.trim().length === 0)}
            >
              {saving ? "Connecting…" : "Connect"}
            </button>
          </div>
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.75rem", opacity: 0.55 }}>{ENCRYPTION_NOTE}</p>
        </>
      )}

      {guide.lifecycle && (
        <p style={{ margin: "0.6rem 0 0", fontSize: "0.78rem", opacity: 0.6 }}>Note: {guide.lifecycle}</p>
      )}

      {msg && <p style={{ margin: "0.5rem 0 0", color: colors.accentText, fontSize: "0.82rem" }}>{msg}</p>}
      {err && <p style={{ margin: "0.5rem 0 0", color: colors.error, fontSize: "0.82rem" }}>{err}</p>}
    </div>
  );
}
