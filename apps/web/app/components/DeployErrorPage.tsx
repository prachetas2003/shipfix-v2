"use client";

import { useState } from "react";
import Link from "next/link";
import { CORPUS_REPO_COUNT, deployErrors, type DeployError, type ErrorSource } from "../lib/deployErrors";
import { colors } from "../lib/theme";
import { BrandMark } from "./BrandMark";

function Header(): React.ReactElement {
  return (
    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: "2.5rem" }}>
      <Link href="/welcome" style={{ textDecoration: "none", color: "inherit" }}>
        <BrandMark />
      </Link>
      <span style={{ display: "flex", gap: 14 }}>
        <Link href="/benchmark" style={{ color: colors.dim, fontSize: "0.86rem" }}>Benchmark</Link>
        <Link href="/errors" style={{ color: colors.dim, fontSize: "0.86rem" }}>Deploy errors</Link>
      </span>
    </header>
  );
}

export function DeployErrorIndex(): React.ReactElement {
  const [source, setSource] = useState<ErrorSource | "all">("all");
  const visible = source === "all" ? deployErrors : deployErrors.filter((error) => error.source === source);
  return (
    <main className="sf-shell" style={{ maxWidth: 880 }}>
      <Header />
      <h1 className="sf-display" style={{ margin: 0, fontSize: "clamp(2rem, 4.5vw, 2.8rem)", maxWidth: 720 }}>
        The deploy errors ShipFix already knows.
      </h1>
      <p style={{ color: colors.muted, lineHeight: 1.6, maxWidth: 680, margin: "1rem 0 0" }}>
        Three of these showed up in the {CORPUS_REPO_COUNT} public repos from the 18 Oct 2026 benchmark. The rest are failures ShipFix matches in host logs after a deploy. Each page starts a deploy on your repo.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "1.5rem 0" }}>
        <Filter current={source} value="all" onSelect={setSource}>All {deployErrors.length}</Filter>
        <Filter current={source} value="corpus" onSelect={setSource}>From the benchmark</Filter>
        <Filter current={source} value="logs" onSelect={setSource}>From deploy logs</Filter>
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {visible.map((error) => (
          <Link
            key={error.slug}
            href={`/errors/${error.slug}`}
            style={{
              textDecoration: "none",
              color: "inherit",
              padding: "0.95rem 1rem",
              background: colors.card,
              border: `1px solid ${colors.border}`,
              borderRadius: 10,
            }}
          >
            <strong style={{ fontWeight: 600 }}>{error.title}</strong>
            <p style={{ margin: "0.3rem 0 0", color: colors.dim, fontSize: "0.9rem", lineHeight: 1.5 }}>
              {error.corpusCount != null ? `${error.corpusCount} of ${CORPUS_REPO_COUNT} repos. ` : ""}
              {error.summary}
            </p>
          </Link>
        ))}
      </div>
    </main>
  );
}

export function DeployErrorDetail({ error }: { error: DeployError }): React.ReactElement {
  return (
    <main className="sf-shell" style={{ maxWidth: 760 }}>
      <Header />
      <p style={{ margin: 0, color: colors.accentText, fontSize: "0.82rem" }}>
        {error.source === "corpus" ? `Benchmark · ${error.corpusCount} of ${CORPUS_REPO_COUNT} repos` : "Deploy logs"}
      </p>
      <h1 className="sf-display" style={{ margin: "0.4rem 0 0", fontSize: "clamp(1.8rem, 4vw, 2.5rem)" }}>{error.title}</h1>
      <p style={{ color: colors.muted, lineHeight: 1.6, margin: "1rem 0 0" }}>{error.whatHappened}</p>
      <section style={{ marginTop: "1.5rem", padding: "1rem 1.05rem", background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 10 }}>
        <strong style={{ fontWeight: 600 }}>What ShipFix does</strong>
        <p style={{ margin: "0.4rem 0 0", color: colors.dim, lineHeight: 1.55 }}>{error.whatShipFixDoes}</p>
      </section>
      <p style={{ marginTop: "1.5rem" }}>
        <Link href="/new" className="sf-btn sf-btn--primary">Fix it automatically</Link>
      </p>
    </main>
  );
}

function Filter({
  current,
  value,
  onSelect,
  children,
}: {
  current: ErrorSource | "all";
  value: ErrorSource | "all";
  onSelect: (value: ErrorSource | "all") => void;
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
