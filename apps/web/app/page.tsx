"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, type AppSummary } from "./lib/api";
import { colors } from "./lib/theme";
import { AppCard } from "./components/AppCard";
import { AppNav, Button, EmptyState, Shell, Skeleton } from "./components/ui";

export default function DashboardPage(): React.ReactElement {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoading(true);
    setErr(null);
    try {
      const { apps } = await api.listApps();
      setApps(apps);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (!opts?.quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const active = apps.some(
      (a) => a.latestRun && !["succeeded", "diagnosed", "failed"].includes(a.latestRun.status),
    );
    if (!active) return;
    const timer = setInterval(() => void load({ quiet: true }), 8000);
    return () => clearInterval(timer);
  }, [apps, load]);

  return (
    <Shell wide>
      <AppNav
        right={
          <Link href="/new" style={{ textDecoration: "none" }}>
            <Button>New deployment</Button>
          </Link>
        }
      />

      <div style={{ marginBottom: "1.75rem" }}>
        <h1 style={{ fontSize: "1.75rem", fontWeight: 600, margin: 0, letterSpacing: "-0.02em" }}>Apps</h1>
        <p style={{ color: colors.dim, margin: "0.4rem 0 0", fontSize: "0.92rem", lineHeight: 1.55, maxWidth: 560 }}>
          Deploy from GitHub, wire providers, and verify the live stack before calling it done.
        </p>
      </div>

      {err && <p style={{ color: colors.error, marginBottom: "1rem" }}>{err}</p>}

      {loading ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Skeleton height={96} />
          <Skeleton height={96} />
        </div>
      ) : apps.length === 0 ? (
        <EmptyState
          title="No apps yet"
          detail="Paste a GitHub repo to analyze and deploy. ShipFix only asks for the providers that plan needs."
          action={
            <Link href="/new" style={{ textDecoration: "none" }}>
              <Button>Analyze a repo</Button>
            </Link>
          }
        />
      ) : (
        <div className="sf-fade-in" style={{ display: "grid", gap: 10 }}>
          {apps.map((app) => (
            <AppCard key={app.projectId} app={app} verification={app.verification ?? []} />
          ))}
        </div>
      )}
    </Shell>
  );
}
