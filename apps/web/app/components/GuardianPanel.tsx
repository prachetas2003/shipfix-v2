"use client";

import { useState } from "react";
import { api } from "../lib/api";
import { colors, mono } from "../lib/theme";
import { Button } from "./ui/Button";
import { Panel } from "./ui/Panel";

/** Live health of the current deploy, plus a fix and a rollback. */
export function GuardianPanel({
  projectId,
  onFix,
  onRollback,
  fixing,
  rollingBack,
}: {
  projectId: string;
  onFix: () => void;
  onRollback: () => void;
  fixing: boolean;
  rollingBack: boolean;
}): React.ReactElement {
  const [lines, setLines] = useState<string[] | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);
  const [alertSent, setAlertSent] = useState(false);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const check = async () => {
    setErr(null);
    setChecking(true);
    try {
      const result = await api.guardianCheck(projectId);
      setLines(result.lines);
      setOk(result.ok);
      setAlertSent(result.alertSent);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Panel style={{ marginBottom: "1rem" }}>
      <strong style={{ fontWeight: 600 }}>Health</strong>
      <p style={{ margin: "0.4rem 0 0", color: colors.dim, fontSize: "0.84rem", lineHeight: 1.5 }}>
        Checks the live URLs from the latest deploy. A failed check can start a new deploy, which runs the fix loop if that deploy fails. Roll back returns to the previous deploy that succeeded.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "0.8rem" }}>
        <Button type="button" onClick={() => void check()} disabled={checking}>
          {checking ? "Checking…" : "Check health"}
        </Button>
        <Button type="button" variant="ghost" onClick={onFix} disabled={fixing || ok !== false}>
          {fixing ? "Starting…" : "Start a fix"}
        </Button>
        <Button type="button" variant="ghost" onClick={onRollback} disabled={rollingBack}>
          {rollingBack ? "Starting…" : "Roll back"}
        </Button>
      </div>
      {err && <p style={{ margin: "0.7rem 0 0", color: colors.error, fontSize: "0.84rem" }}>{err}</p>}
      {lines && (
        <pre
          style={{
            margin: "0.75rem 0 0",
            padding: "0.7rem 0.8rem",
            background: colors.panelSoft,
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            color: ok ? colors.successText : colors.warnText,
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
