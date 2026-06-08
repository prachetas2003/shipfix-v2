"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { api, type AppDetail } from "../../lib/api";
import { buildAppResourceDisplay } from "../../lib/resourceDisplay";
import { colors, h2, mono } from "../../lib/theme";
import { CurrentState } from "../../components/CurrentState";

const STATUS_COLOR: Record<string, string> = {
  succeeded: colors.success,
  diagnosed: colors.warn,
  failed: colors.error,
};

export default function AppDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): React.ReactElement {
  const { projectId } = use(params);
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api.getApp(projectId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  const visibleDeployment = detail?.latestLiveDeployment ?? detail?.current;
  const display =
    visibleDeployment &&
    buildAppResourceDisplay({
      resources: visibleDeployment.resources,
      layers: visibleDeployment.layers,
      verification: visibleDeployment.verification,
    });

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "2.5rem 1.5rem 6rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: "1rem", flexWrap: "wrap" }}>
        <Link href="/" style={{ color: colors.dim, textDecoration: "none", fontSize: "0.85rem" }}>
          ← My Apps
        </Link>
        <h1 style={{ fontSize: "1.5rem", margin: 0, fontFamily: mono }}>
          {detail?.project.repoFullName ?? "App"}
        </h1>
        <Link href="/new" style={{ marginLeft: "auto", textDecoration: "none", color: colors.accentText, fontSize: "0.9rem" }}>
          New deployment →
        </Link>
      </div>

      {err && <p style={{ color: colors.error }}>{err}</p>}

      {display && (
        <div style={{ marginBottom: "2rem" }}>
          {detail?.latestLiveDeployment && detail.current?.runId !== detail.latestLiveDeployment.runId && (
            <p style={{ color: colors.warn, fontSize: "0.88rem", marginTop: 0 }}>
              Latest run is {detail.history[0]?.status}. Showing the most recent live deployment links below.
            </p>
          )}
          <CurrentState display={display} />
        </div>
      )}

      <section>
        <h2 style={h2}>Deployment history</h2>
        {detail?.history.length === 0 && <p style={{ opacity: 0.6 }}>No runs yet.</p>}
        <div style={{ marginTop: "0.75rem" }}>
          {detail?.history.map((r) => (
            <Link key={r.id} href={`/runs/${r.id}`} style={{ textDecoration: "none", color: "inherit" }}>
              <div
                style={{
                  background: colors.card,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 10,
                  padding: "1rem",
                  marginBottom: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    fontSize: "0.7rem",
                    fontWeight: 700,
                    color: "#0b0b0b",
                    background: STATUS_COLOR[r.status] ?? colors.dim,
                    padding: "0.1rem 0.5rem",
                    borderRadius: 999,
                    minWidth: 80,
                    textAlign: "center",
                  }}
                >
                  {r.status}
                </span>
                <span style={{ opacity: 0.75, fontSize: "0.85rem" }}>{r.mode}</span>
                <span style={{ opacity: 0.5, fontSize: "0.8rem", fontFamily: mono }}>{r.commitSha.slice(0, 8)}</span>
                <span style={{ marginLeft: "auto", opacity: 0.5, fontSize: "0.8rem" }}>
                  {new Date(r.startedAt).toLocaleString()}
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
