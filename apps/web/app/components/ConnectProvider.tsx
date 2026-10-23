"use client";

import { useState } from "react";
import { api } from "../lib/api";
import { ENCRYPTION_NOTE, providerGuide, type ProviderId } from "../lib/providerGuide";
import { colors, inputStyle, mono } from "../lib/theme";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Panel } from "./ui/Panel";

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
  allowUpdate = false,
  initiallyEditing = false,
  oauthReady = false,
}: {
  providerId: ProviderId;
  connected: boolean;
  reason?: string;
  onConnected?: () => void;
  /** When true, a connected provider can expand an Update credentials form. */
  allowUpdate?: boolean;
  /** Open the credential form immediately (used after a permission failure). */
  initiallyEditing?: boolean;
  /** This ShipFix server has an OAuth app for the provider. */
  oauthReady?: boolean;
}): React.ReactElement | null {
  const guide = providerGuide(providerId);
  const [value, setValue] = useState("");
  const [optionalValues, setOptionalValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(Boolean(initiallyEditing && (allowUpdate || !connected)));

  if (!guide) return null;

  const showForm = !connected || editing;

  const connectWithLogin = async () => {
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      const redirectUri = `${window.location.origin}/providers/callback`;
      const started = await api.startProviderOauth(guide.id, redirectUri);
      if (started.verifier) sessionStorage.setItem(`shipfix-oauth:${started.state}`, started.verifier);
      window.location.assign(started.authorizeUrl);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      await api.disconnectProvider(guide.id);
      setMsg(`${guide.name} disconnected.`);
      onConnected?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

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
      setEditing(false);
      setMsg(connected ? `${guide.name} credentials updated.` : `${guide.name} connected.`);
      onConnected?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      className="sf-slide-up"
      style={{
        marginBottom: 10,
        borderColor: connected && !editing ? colors.successDeep : colors.border,
        background: connected && !editing ? colors.successBg : colors.card,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 420px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: "0.95rem", fontWeight: 600 }}>{guide.name}</strong>
            <span style={{ color: colors.dim, fontSize: "0.82rem" }}>{guide.blurb}</span>
          </div>
          {reason && <p style={{ margin: "0.45rem 0 0", fontSize: "0.85rem", color: colors.muted }}>{reason}</p>}
          <p style={{ margin: "0.45rem 0 0", fontSize: "0.85rem", color: colors.dim, lineHeight: 1.55 }}>{guide.whatFor}</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Badge tone={connected ? "success" : "warn"}>{connected ? "Connected" : "Setup needed"}</Badge>
          {connected && allowUpdate && !editing && (
            <Button type="button" variant="ghost" onClick={() => setEditing(true)}>
              Update credentials
            </Button>
          )}
          {connected && allowUpdate && !editing && (
            <Button type="button" variant="ghost" disabled={saving} onClick={() => void disconnect()}>
              Disconnect
            </Button>
          )}
          {connected && allowUpdate && editing && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setErr(null);
                setValue("");
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>

      {guide.extraSteps && guide.extraSteps.length > 0 && (
        <div style={{ marginTop: "0.85rem" }}>
          <strong style={{ fontSize: "0.9rem" }}>{guide.extraStepsTitle ?? "Account setup"}</strong>
          <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", color: colors.dim, lineHeight: 1.5 }}>
            Saving the Vercel token leaves GitHub as its own step. Do these on the GitHub account that owns the repo, then deploy.
          </p>
          {guide.extraSteps.map((step, index) => (
            <div
              key={step.title}
              style={{
                marginTop: 10,
                padding: "0.75rem",
                background: colors.warnBg,
                border: `1px solid ${colors.warnBorder}`,
                borderRadius: 8,
              }}
            >
              <strong style={{ fontSize: "0.85rem", color: colors.warnText }}>
                {index + 1}. {step.title}
              </strong>
              <p style={{ margin: "0.3rem 0 0", fontSize: "0.82rem", color: colors.warnText, opacity: 0.92, lineHeight: 1.5 }}>
                {step.detail}
              </p>
              {step.url && (
                <a href={step.url} target="_blank" rel="noreferrer" style={{ color: colors.accentText, fontSize: "0.82rem", fontWeight: 600 }}>
                  {step.urlLabel ?? step.url}
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <>
          <div style={{ marginTop: "0.8rem", borderTop: `1px solid ${colors.border}`, paddingTop: "0.8rem" }}>
            {oauthReady && (
              <div style={{ marginBottom: 12 }}>
                <Button type="button" onClick={() => void connectWithLogin()} disabled={saving}>
                  {saving ? "Opening…" : `Connect with ${guide.name}`}
                </Button>
                <p style={{ margin: "0.45rem 0 0", fontSize: "0.8rem", color: colors.dim }}>
                  Or paste a key below.
                </p>
              </div>
            )}
            <p style={{ margin: 0, fontSize: "0.85rem", color: colors.muted, lineHeight: 1.6 }}>
              {connected ? "Paste a new " : "Create an account-level "}
              {guide.credentialLabel.toLowerCase()} at{" "}
              <a href={guide.tokenUrl} target="_blank" rel="noreferrer" style={{ color: colors.accentText, fontWeight: 600 }}>
                {guide.tokenUrlLabel}
              </a>
              . {guide.scope}
            </p>
          </div>

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
                onChange={(e) => setOptionalValues((prev) => ({ ...prev, [field.field]: e.target.value }))}
                placeholder={field.placeholder}
                spellCheck={false}
                style={{ ...inputStyle, flex: 1, minWidth: 220, fontFamily: mono, padding: "0.55rem 0.75rem" }}
                aria-label={`${guide.name} ${field.label}`}
              />
            ))}
            <Button
              onClick={() => void connect()}
              disabled={
                saving ||
                value.trim().length === 0 ||
                (guide.optionalFields ?? []).some((f) => f.required && !(optionalValues[f.field] ?? "").trim())
              }
            >
              {saving ? "Saving…" : connected ? `Update ${guide.name}` : `Connect ${guide.name}`}
            </Button>
          </div>
          <p style={{ margin: "0.55rem 0 0", fontSize: "0.76rem", color: colors.dim, lineHeight: 1.45 }}>{ENCRYPTION_NOTE}</p>
        </>
      )}

      {guide.lifecycle && (
        <p style={{ margin: "0.65rem 0 0", fontSize: "0.78rem", color: colors.dim, lineHeight: 1.45 }}>Note: {guide.lifecycle}</p>
      )}

      {msg && <p style={{ margin: "0.55rem 0 0", color: colors.success, fontSize: "0.82rem" }}>{msg}</p>}
      {err && <p style={{ margin: "0.55rem 0 0", color: colors.error, fontSize: "0.82rem" }}>{err}</p>}
    </Panel>
  );
}
