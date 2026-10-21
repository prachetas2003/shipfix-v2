"use client";

import { useState } from "react";
import { api } from "../lib/api";
import { colors, mono } from "../lib/theme";
import { Button } from "./ui/Button";
import { Panel } from "./ui/Panel";

/** Spend the app has actually measured, plus a cap the user can set. */
export function BillPanel({ projectId }: { projectId: string }): React.ReactElement {
  const [capInput, setCapInput] = useState("");
  const [lines, setLines] = useState<string[] | null>(null);
  const [over, setOver] = useState(false);
  const [spike, setSpike] = useState(false);
  const [alertSent, setAlertSent] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const saveCap = async () => {
    setErr(null);
    setSaved(null);
    const trimmed = capInput.trim();
    let capCents: number | null = null;
    if (trimmed) {
      const dollars = Number(trimmed);
      if (!Number.isFinite(dollars) || dollars < 0) {
        setErr("Enter a dollar amount, or leave the field empty to clear the cap.");
        return;
      }
      capCents = Math.round(dollars * 100);
    }
    setSaving(true);
    try {
      const savedCap = await api.guardianCap(projectId, capCents);
      setSaved(savedCap.capCents == null ? "Spend cap cleared." : `Spend cap saved at $${(savedCap.capCents / 100).toFixed(2)}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const check = async () => {
    setErr(null);
    setChecking(true);
    try {
      const result = await api.guardianBills(projectId);
      setLines(result.lines);
      setOver(result.over);
      setSpike(result.spike);
      setAlertSent(result.alertSent);
      if (result.capCents != null) setCapInput((result.capCents / 100).toFixed(2));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Panel style={{ marginBottom: "1rem" }}>
      <strong style={{ fontWeight: 600 }}>Spend</strong>
      <p style={{ margin: "0.4rem 0 0", color: colors.dim, fontSize: "0.84rem", lineHeight: 1.5 }}>
        Counts this month&apos;s ShipFix model estimates and a Vercel account bill when that token can read one. Render shows bandwidth, not a price. Neon, Supabase, and Upstash are named and not converted into dollars.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "0.8rem", alignItems: "center" }}>
        <label style={{ color: colors.dim, fontSize: "0.84rem" }}>
          Cap in dollars
          <input
            value={capInput}
            onChange={(event) => setCapInput(event.target.value)}
            inputMode="decimal"
            placeholder="No cap"
            aria-label="Spend cap in dollars"
            style={{
              display: "block",
              marginTop: 4,
              width: 120,
              padding: "0.4rem 0.55rem",
              background: colors.panelSoft,
              color: colors.text,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              fontFamily: mono,
            }}
          />
        </label>
        <Button type="button" variant="ghost" onClick={() => void saveCap()} disabled={saving}>
          {saving ? "Saving…" : "Save cap"}
        </Button>
        <Button type="button" onClick={() => void check()} disabled={checking}>
          {checking ? "Checking…" : "Check spend"}
        </Button>
      </div>
      {saved && <p style={{ margin: "0.7rem 0 0", color: colors.successText, fontSize: "0.84rem" }}>{saved}</p>}
      {err && <p style={{ margin: "0.7rem 0 0", color: colors.error, fontSize: "0.84rem" }}>{err}</p>}
      {lines && (
        <pre
          style={{
            margin: "0.75rem 0 0",
            padding: "0.7rem 0.8rem",
            background: colors.panelSoft,
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            color: over || spike ? colors.warnText : colors.successText,
            fontFamily: mono,
            fontSize: "0.78rem",
            whiteSpace: "pre-wrap",
          }}
        >
          {lines.join("\n")}
          {alertSent ? "\nSlack was notified." : ""}
        </pre>
      )}
    </Panel>
  );
}
