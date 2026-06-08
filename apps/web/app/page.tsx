"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, type AppSummary } from "./lib/api";
import { buttonStyle, card, colors } from "./lib/theme";
import { AppCard } from "./components/AppCard";

export default function DashboardPage(): React.ReactElement {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { apps } = await api.listApps();
      setApps(apps);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "3rem 1.5rem 6rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: "2rem", margin: 0 }}>ShipFix</h1>
          <p style={{ opacity: 0.65, margin: "0.25rem 0 0", fontSize: "0.95rem", maxWidth: 620 }}>
            Guided deployment from a GitHub repo to a live, verified app. ShipFix auto-deploys Vite
            frontends (Vercel), Node APIs (Render), and Postgres (Neon). Anything outside that gets an
            honest diagnosis instead of a broken deploy.
          </p>
        </div>
        <Link href="/new" style={{ marginLeft: "auto", textDecoration: "none" }}>
          <button style={buttonStyle("primary")}>New deployment</button>
        </Link>
      </div>

      {err && <p style={{ color: colors.error, marginTop: "1.5rem" }}>{err}</p>}

      <section style={{ marginTop: "2rem" }}>
        {loading ? (
          <p style={{ opacity: 0.6 }}>Loading your apps…</p>
        ) : apps.length === 0 ? (
          <div style={{ ...card, textAlign: "center", padding: "2.5rem 1rem" }}>
            <p style={{ fontSize: "1.05rem", margin: 0 }}>No apps yet.</p>
            <p style={{ opacity: 0.65, margin: "0.5rem 0 1.25rem", fontSize: "0.9rem" }}>
              Deploy your first repository to see it here, with live frontend, backend, and database links.
            </p>
            <Link href="/new" style={{ textDecoration: "none" }}>
              <button style={buttonStyle("primary")}>Deploy your first app</button>
            </Link>
          </div>
        ) : (
          apps.map((app) => (
            <AppCard key={app.projectId} app={app} verification={app.verification ?? []} />
          ))
        )}
      </section>
    </main>
  );
}
