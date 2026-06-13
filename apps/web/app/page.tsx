"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, type AppSummary } from "./lib/api";
import { buttonStyle, card, colors } from "./lib/theme";
import { AppCard } from "./components/AppCard";
import { BrandMark } from "./components/BrandMark";

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
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "3rem 1.5rem 6rem" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 18, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 560px" }}>
          <BrandMark size={38} />
          <h1 style={{ fontSize: "2.25rem", margin: "1.1rem 0 0", letterSpacing: 0 }}>
            Deploy full-stack apps with proof.
          </h1>
          <p style={{ color: colors.dim, margin: "0.55rem 0 0", fontSize: "1rem", lineHeight: 1.65, maxWidth: 720 }}>
            ShipFix analyzes a GitHub repo, plans the deployment, connects the required providers,
            ships Vite, Next.js, Node API, and Postgres services, then verifies the live system before calling it done.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "1rem" }}>
            {["Vite + Next.js on Vercel", "Node API on Render", "Neon Postgres", "Live verification"].map((item) => (
              <span
                key={item}
                style={{
                  border: `1px solid ${colors.border}`,
                  background: colors.panelSoft,
                  color: colors.muted,
                  borderRadius: 999,
                  padding: "0.28rem 0.7rem",
                  fontSize: "0.78rem",
                  fontWeight: 600,
                }}
              >
                {item}
              </span>
            ))}
          </div>
        </div>
        <Link href="/new" style={{ marginLeft: "auto", textDecoration: "none" }}>
          <button style={buttonStyle("primary")}>New deployment</button>
        </Link>
      </div>

      {err && <p style={{ color: colors.error, marginTop: "1.5rem" }}>{err}</p>}

      <section style={{ marginTop: "2rem" }}>
        {loading ? (
          <p style={{ color: colors.dim }}>Loading your apps...</p>
        ) : apps.length === 0 ? (
          <div style={{ ...card, textAlign: "center", padding: "2.75rem 1.25rem", background: colors.panelSoft }}>
            <p style={{ fontSize: "1.15rem", margin: 0, fontWeight: 700 }}>No apps deployed yet</p>
            <p style={{ color: colors.dim, margin: "0.55rem auto 1.35rem", fontSize: "0.92rem", maxWidth: 560, lineHeight: 1.6 }}>
              Start with a GitHub repo. ShipFix will show a deployment plan first, then ask for only the providers that app needs.
            </p>
            <Link href="/new" style={{ textDecoration: "none" }}>
              <button style={buttonStyle("primary")}>Analyze your first repo</button>
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
