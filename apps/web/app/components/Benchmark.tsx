"use client";

import { useState } from "react";
import Link from "next/link";
import {
  benchmarkByCategory,
  benchmarkGeneratedAt,
  benchmarkPercent,
  benchmarkRepos,
  benchmarkUncloned,
  countBenchmark,
  type BenchmarkCategory,
} from "../lib/benchmark";
import { colors, mono } from "../lib/theme";
import { BrandMark } from "./BrandMark";

const OUTCOME_LABEL: Record<(typeof benchmarkRepos)[number]["outcome"], string> = {
  first_try: "First-try plan",
  after_setup: "Plan after setup",
  unplanned: "No deterministic plan",
};

const totals = countBenchmark(benchmarkRepos);
const byCategory = benchmarkByCategory(benchmarkRepos);
const planned = totals.firstTry + totals.afterSetup;

function Stat({ value, label }: { value: string; label: string }): React.ReactElement {
  return (
    <div style={{ padding: "1rem 1.05rem", background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 10 }}>
      <div className="sf-display" style={{ fontSize: "1.7rem" }}>{value}</div>
      <p style={{ margin: "0.35rem 0 0", color: colors.dim, fontSize: "0.88rem", lineHeight: 1.45 }}>{label}</p>
    </div>
  );
}

export function Benchmark(): React.ReactElement {
  const [category, setCategory] = useState<BenchmarkCategory | "all">("all");
  const visible = category === "all" ? benchmarkRepos : benchmarkRepos.filter((repo) => repo.category === category);
  const ranOn = new Date(benchmarkGeneratedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <main className="sf-shell" style={{ maxWidth: 880 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: "2.5rem" }}>
        <Link href="/welcome" style={{ textDecoration: "none", color: "inherit" }}>
          <BrandMark />
        </Link>
        <Link href="/welcome" style={{ color: colors.dim, fontSize: "0.86rem" }}>
          Home
        </Link>
      </header>

      <p style={{ margin: 0, color: colors.accentText, fontSize: "0.82rem" }}>Benchmark · {ranOn}</p>
      <h1 className="sf-display" style={{ margin: "0.4rem 0 0", fontSize: "clamp(2rem, 4.5vw, 2.8rem)", maxWidth: 720 }}>
        {totals.firstTry} of {totals.repos} public AI-built repos get a first-try plan.
      </h1>
      <p style={{ color: colors.muted, fontSize: "1.02rem", lineHeight: 1.6, maxWidth: 680, margin: "1rem 0 0" }}>
        ShipFix analyzed {totals.repos} public GitHub repos from Lovable, Bolt, v0, Cursor, and Replit, then asked whether its planner could deploy them with Vercel, Render, Neon, Upstash, and Supabase connected. {benchmarkPercent(totals.firstTry, totals.repos)} have a plan with nothing left to ask. {benchmarkPercent(planned, totals.repos)} have a plan once the user supplies missing values.
      </p>

      <section style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginTop: "1.75rem" }}>
        <Stat value={benchmarkPercent(totals.firstTry, totals.repos)} label={`${totals.firstTry} first-try plans. Nothing for the user to fill in.`} />
        <Stat value={benchmarkPercent(planned, totals.repos)} label={`${planned} plans after setup questions, including the first-try set.`} />
        <Stat value={benchmarkPercent(totals.unplanned, totals.repos)} label={`${totals.unplanned} repos outside the deterministic planner.`} />
      </section>

      <section style={{ marginTop: "2.25rem", overflowX: "auto" }}>
        <h2 className="sf-display" style={{ fontSize: "1.35rem", margin: "0 0 0.75rem" }}>By where the repo came from</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
          <thead>
            <tr style={{ color: colors.dim, textAlign: "left" }}>
              <th style={{ padding: "0.45rem 0.5rem", fontWeight: 500 }}>Source</th>
              <th style={{ padding: "0.45rem 0.5rem", fontWeight: 500 }}>Repos</th>
              <th style={{ padding: "0.45rem 0.5rem", fontWeight: 500 }}>First try</th>
              <th style={{ padding: "0.45rem 0.5rem", fontWeight: 500 }}>After setup</th>
            </tr>
          </thead>
          <tbody>
            {byCategory.map((row) => (
              <tr key={row.id} style={{ borderTop: `1px solid ${colors.border}` }}>
                <td style={{ padding: "0.55rem 0.5rem" }}>{row.label}</td>
                <td style={{ padding: "0.55rem 0.5rem" }}>{row.counts.repos}</td>
                <td style={{ padding: "0.55rem 0.5rem" }}>{row.counts.firstTry} ({benchmarkPercent(row.counts.firstTry, row.counts.repos)})</td>
                <td style={{ padding: "0.55rem 0.5rem" }}>{row.counts.firstTry + row.counts.afterSetup} ({benchmarkPercent(row.counts.firstTry + row.counts.afterSetup, row.counts.repos)})</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ marginTop: "2.25rem" }}>
        <h2 className="sf-display" style={{ fontSize: "1.35rem", margin: 0 }}>Method</h2>
        <div style={{ color: colors.dim, lineHeight: 1.6, display: "grid", gap: 10, marginTop: "0.6rem" }}>
          <p style={{ margin: 0 }}>
            The run is the offline corpus from {ranOn}. Each repo was shallow-cloned, analyzed, given a deterministic plan, and validated. The planner assumed the user had already connected every supported provider. No provider was called, and no app was deployed.
          </p>
          <p style={{ margin: 0 }}>
            A repo is in this set when its README matched a discovery query for Lovable, Bolt, v0, vibe-coding, or Replit Agent. That includes apps, and also lists, skills, and templates. {benchmarkUncloned} matching repos failed to clone and are omitted. Local fixtures, negative cases, starters, tutorials, and other open-source repos in the wider corpus are omitted too.
          </p>
          <p style={{ margin: 0 }}>
            The same repos have not yet been deployed live on ShipFix, Vercel, Render, Railway, Netlify, or Lovable Cloud. Those success rates will be added when that run exists. The product target for a live, verified deploy with no human help is 50%. The failures ShipFix already names are listed on the <Link href="/errors" style={{ color: colors.accentText }}>deploy error pages</Link>.
          </p>
        </div>
      </section>

      <section style={{ marginTop: "2.25rem" }}>
        <h2 className="sf-display" style={{ fontSize: "1.35rem", margin: "0 0 0.75rem" }}>Every repo in the run</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: "0.85rem" }}>
          <FilterButton current={category} value="all" onSelect={setCategory}>All {totals.repos}</FilterButton>
          {byCategory.map((row) => (
            <FilterButton key={row.id} current={category} value={row.id} onSelect={setCategory}>
              {row.label} {row.counts.repos}
            </FilterButton>
          ))}
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.86rem" }}>
            <thead>
              <tr style={{ color: colors.dim, textAlign: "left" }}>
                <th style={{ padding: "0.4rem 0.5rem", fontWeight: 500 }}>Repo</th>
                <th style={{ padding: "0.4rem 0.5rem", fontWeight: 500 }}>Result</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((repo) => (
                <tr key={repo.repo} style={{ borderTop: `1px solid ${colors.border}` }}>
                  <td style={{ padding: "0.45rem 0.5rem" }}>
                    <a href={`https://github.com/${repo.repo}`} style={{ color: colors.accentText, fontFamily: mono, fontSize: "0.8rem" }}>
                      {repo.repo}
                    </a>
                  </td>
                  <td style={{ padding: "0.45rem 0.5rem", color: colors.muted }}>{OUTCOME_LABEL[repo.outcome]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function FilterButton({
  current,
  value,
  onSelect,
  children,
}: {
  current: BenchmarkCategory | "all";
  value: BenchmarkCategory | "all";
  onSelect: (value: BenchmarkCategory | "all") => void;
  children: React.ReactNode;
}): React.ReactElement {
  const selected = current === value;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(value)}
      style={{
        border: `1px solid ${selected ? colors.accentBorder : colors.border}`,
        background: selected ? colors.accentBg : "transparent",
        color: selected ? colors.accentText : colors.muted,
        borderRadius: 999,
        padding: "0.3rem 0.7rem",
        fontSize: "0.8rem",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
