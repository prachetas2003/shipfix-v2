"use client";

import Link from "next/link";
import { use } from "react";
import { useRun } from "../../lib/useRun";
import { colors, mono } from "../../lib/theme";
import { FixGuidance } from "../../components/FixGuidance";
import { OutcomeBanner } from "../../components/OutcomeBanner";
import { PlanPanel } from "../../components/PlanPanel";
import { Timeline } from "../../components/Timeline";

export default function RunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}): React.ReactElement {
  const { runId } = use(params);
  const run = useRun(runId);
  const snap = run.snapshot;

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "2.5rem 1.5rem 6rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: "1rem" }}>
        <Link href="/" style={{ color: colors.dim, textDecoration: "none", fontSize: "0.85rem" }}>
          ← My Apps
        </Link>
        <h1 style={{ fontSize: "1.4rem", margin: 0 }}>Deployment run</h1>
      </div>

      {snap?.run.repoFullName && (
        <p style={{ opacity: 0.7, fontFamily: mono, fontSize: "0.9rem" }}>
          {snap.run.repoFullName} · {snap.run.mode} · status <strong>{snap.run.status}</strong>
        </p>
      )}
      {run.status === "loading" && <p style={{ opacity: 0.6 }}>Loading run…</p>}
      {run.error && <p style={{ color: colors.error }}>{run.error}</p>}

      <OutcomeBanner status={run.status} snapshot={snap} />
      <FixGuidance events={run.events} />
      {run.plan && <PlanPanel plan={run.plan} />}
      <Timeline events={run.events} />

      {snap?.run.projectId && (
        <p style={{ marginTop: "2rem" }}>
          <Link href={`/apps/${snap.run.projectId}`} style={{ color: colors.accentText }}>
            View all runs for this app →
          </Link>
        </p>
      )}
    </main>
  );
}
