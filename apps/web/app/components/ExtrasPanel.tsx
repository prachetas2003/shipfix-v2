"use client";

import { useState } from "react";
import { api } from "../lib/api";
import { colors, mono } from "../lib/theme";
import { Button } from "./ui/Button";
import { Panel } from "./ui/Panel";

/** Backups, a custom domain, and teardown for resources ShipFix recorded. */
export function ExtrasPanel({ projectId, repoFullName }: { projectId: string; repoFullName: string }): React.ReactElement {
  const [hostname, setHostname] = useState("");
  const [branchName, setBranchName] = useState("");
  const [confirm, setConfirm] = useState("");
  const [lines, setLines] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (label: string, work: () => Promise<{ lines: string[] }>) => {
    setErr(null);
    setBusy(label);
    try {
      const result = await work();
      setLines(result.lines);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel style={{ marginBottom: "1rem" }}>
      <strong style={{ fontWeight: 600 }}>Backups and teardown</strong>
      <p style={{ margin: "0.4rem 0 0", color: colors.dim, fontSize: "0.84rem", lineHeight: 1.5 }}>
        This app has one environment, production. A pull-request preview is not started, because another deploy updates the same hosts. A backup is a Neon branch or a Supabase restore point. Teardown deletes the Vercel project, Render service, Neon project, and Upstash database ShipFix recorded. A Supabase project is left in place.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "0.8rem" }}>
        <Button type="button" onClick={() => void run("backup", () => api.guardianBackup(projectId))} disabled={busy !== null}>
          {busy === "backup" ? "Working…" : "Take a backup"}
        </Button>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "0.8rem", alignItems: "end" }}>
        <label style={{ color: colors.dim, fontSize: "0.84rem" }}>
          Neon backup branch
          <input
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
            aria-label="Neon backup branch"
            placeholder="shipfix-backup-…"
            style={fieldStyle}
          />
        </label>
        <Button
          type="button"
          variant="ghost"
          disabled={busy !== null || branchName.trim() === "" || confirm.trim() !== repoFullName}
          onClick={() => void run("restore", () => api.guardianRestore(projectId, confirm, branchName.trim()))}
        >
          {busy === "restore" ? "Working…" : "Restore backup"}
        </Button>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "0.8rem", alignItems: "end" }}>
        <label style={{ color: colors.dim, fontSize: "0.84rem" }}>
          Hostname
          <input
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            aria-label="Custom hostname"
            placeholder="app.example.com"
            style={fieldStyle}
          />
        </label>
        <Button
          type="button"
          variant="ghost"
          disabled={busy !== null || hostname.trim() === ""}
          onClick={() => void run("domain", () => api.guardianDomain(projectId, hostname.trim()))}
        >
          {busy === "domain" ? "Working…" : "Attach domain"}
        </Button>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "0.8rem", alignItems: "end" }}>
        <label style={{ color: colors.dim, fontSize: "0.84rem" }}>
          Type {repoFullName || "the repo name"} to confirm
          <input
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            aria-label="Repo name confirmation"
            placeholder={repoFullName}
            style={fieldStyle}
          />
        </label>
        <Button
          type="button"
          variant="ghost"
          disabled={busy !== null || confirm.trim() !== repoFullName || repoFullName === ""}
          onClick={() => void run("teardown", () => api.guardianTeardown(projectId, confirm.trim()))}
        >
          {busy === "teardown" ? "Working…" : "Tear down"}
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
            color: colors.muted,
            fontFamily: mono,
            fontSize: "0.78rem",
            whiteSpace: "pre-wrap",
          }}
        >
          {lines.join("\n")}
        </pre>
      )}
    </Panel>
  );
}

const fieldStyle = {
  display: "block",
  marginTop: 4,
  width: 220,
  padding: "0.4rem 0.55rem",
  background: colors.panelSoft,
  color: colors.text,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  fontFamily: mono,
};
