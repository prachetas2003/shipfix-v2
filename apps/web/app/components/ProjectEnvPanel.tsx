"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { buttonStyle, card, colors, h2, mono } from "../lib/theme";

type EnvRow = { name: string; isSecret: boolean; value: string | null; updatedAt: string };

export function ProjectEnvPanel({ projectId }: { projectId: string }): React.ReactElement {
  const [vars, setVars] = useState<EnvRow[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [isSecret, setIsSecret] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listProjectEnv(projectId);
      setVars(res.vars);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || !value) return;
    setBusy(true);
    setErr(null);
    try {
      await api.upsertProjectEnv(projectId, [{ name: trimmedName, value, isSecret }]);
      setName("");
      setValue("");
      setIsSecret(true);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (envName: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api.deleteProjectEnv(projectId, envName);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={{ ...card, margin: "1.5rem 0" }}>
      <h2 style={h2}>Environment</h2>
      <p style={{ margin: "0.4rem 0 0", color: colors.dim, fontSize: "0.88rem", lineHeight: 1.55 }}>
        Production env for this app. Secrets are sealed and never shown again. Redeploys pick these up for
        unanswered plan secrets.
      </p>

      {err && (
        <p style={{ color: colors.error, marginTop: "0.75rem", fontSize: "0.86rem" }}>{err}</p>
      )}

      {vars.length === 0 ? (
        <p style={{ color: colors.dim, marginTop: "0.9rem", fontSize: "0.86rem" }}>No env vars saved yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: "0.9rem 0 0", padding: 0, display: "grid", gap: 8 }}>
          {vars.map((v) => (
            <li
              key={v.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                border: `1px solid ${colors.border}`,
                borderRadius: 8,
                padding: "0.65rem 0.75rem",
                background: colors.panelSoft,
              }}
            >
              <code style={{ fontFamily: mono, fontWeight: 700 }}>{v.name}</code>
              <span style={{ color: colors.dim, fontSize: "0.78rem" }}>
                {v.isSecret ? "Secret (hidden)" : v.value}
              </span>
              <button
                type="button"
                onClick={() => void remove(v.name)}
                disabled={busy}
                style={{ ...buttonStyle("ghost"), marginLeft: "auto", fontSize: "0.78rem" }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: "grid", gap: 8, marginTop: "1rem" }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="NAME"
          style={inputStyle}
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={isSecret ? "Secret value" : "Value"}
          type={isSecret ? "password" : "text"}
          style={inputStyle}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: colors.muted, fontSize: "0.84rem" }}>
          <input type="checkbox" checked={isSecret} onChange={(e) => setIsSecret(e.target.checked)} />
          Store as secret
        </label>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !name.trim() || !value}
          style={buttonStyle("primary", busy || !name.trim() || !value)}
        >
          {busy ? "Saving..." : "Save env var"}
        </button>
      </div>
    </section>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: colors.panelSoft,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  color: colors.text,
  padding: "0.65rem 0.75rem",
  fontFamily: mono,
  fontSize: "0.88rem",
};
