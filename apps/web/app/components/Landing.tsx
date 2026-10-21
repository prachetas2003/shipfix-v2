"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { readmeMarkdown } from "../lib/readmeBadges";
import { colors, mono } from "../lib/theme";
import { BrandMark } from "./BrandMark";
import { Button } from "./ui/Button";

const POINTS = [
  {
    title: "Your accounts, not ours",
    detail: "Frontend on Vercel, backend on Render, Postgres on Neon or the Supabase project you already have. ShipFix does not host the app.",
  },
  {
    title: "A tested fix, as a pull request",
    detail: "When a deploy fails, ShipFix tries a fix in a sandbox and opens one pull request. Your default branch stays as it is until you merge.",
  },
  {
    title: "Checked before you call it live",
    detail: "The plan includes a launch readiness score: committed secrets, row security, and response headers. ShipFix does not probe a live database.",
  },
];

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.left = "-9999px";
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    return ok;
  }
}

function CopyBlock({ label, value }: { label: string; value: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [blocked, setBlocked] = useState(false);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: "0.82rem", color: colors.dim }}>{label}</span>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            void copyText(value).then((ok) => {
              setCopied(ok);
              setBlocked(!ok);
              if (ok) window.setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          {copied ? "Copied" : blocked ? "Select the text" : "Copy"}
        </Button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "0.75rem 0.85rem",
          overflowX: "auto",
          background: colors.panelSoft,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          color: colors.muted,
          fontFamily: mono,
          fontSize: "0.75rem",
          lineHeight: 1.45,
        }}
      >
        {value}
      </pre>
    </div>
  );
}

/** Public explanation of ShipFix. Sign-in actions are passed in by the auth gate. */
export function Landing({ actions }: { actions?: ReactNode }): React.ReactElement {
  const [snippets, setSnippets] = useState(() => readmeMarkdown("https://shipfix.example"));

  useEffect(() => {
    setSnippets(readmeMarkdown(window.location.origin));
  }, []);

  return (
    <main className="sf-shell" style={{ maxWidth: 880 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: "3rem" }}>
        <BrandMark />
        <span style={{ display: "flex", gap: 14 }}>
          <Link href="/benchmark" style={{ color: colors.dim, fontSize: "0.86rem" }}>
            Benchmark
          </Link>
          <Link href="/errors" style={{ color: colors.dim, fontSize: "0.86rem" }}>
            Deploy errors
          </Link>
        </span>
      </header>

      <h1 className="sf-display" style={{ margin: 0, fontSize: "clamp(2.1rem, 5vw, 3.3rem)", maxWidth: 720 }}>
        Your full-stack app, live in your own accounts.
      </h1>
      <p style={{ color: colors.muted, fontSize: "1.05rem", lineHeight: 1.6, maxWidth: 640, margin: "1rem 0 0" }}>
        Tell Cursor, Claude Code, or Codex to ship it. ShipFix deploys the frontend, backend, database, environment, and migrations, then checks that the live app actually came up.
      </p>

      {actions && <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: "1.5rem", alignItems: "center" }}>{actions}</div>}

      <section style={{ display: "grid", gap: 12, marginTop: "2.75rem" }}>
        {POINTS.map((point) => (
          <article
            key={point.title}
            style={{
              padding: "1rem 1.05rem",
              background: colors.card,
              border: `1px solid ${colors.border}`,
              borderRadius: 10,
            }}
          >
            <strong style={{ fontWeight: 600 }}>{point.title}</strong>
            <p style={{ margin: "0.35rem 0 0", color: colors.dim, lineHeight: 1.55, fontSize: "0.92rem" }}>{point.detail}</p>
          </article>
        ))}
      </section>

      <section style={{ marginTop: "2.75rem" }}>
        <h2 className="sf-display" style={{ fontSize: "1.45rem", margin: 0 }}>
          Put it on the repo
        </h2>
        <p style={{ color: colors.dim, lineHeight: 1.55, margin: "0.45rem 0 1rem" }}>
          The button opens ShipFix on this repo. The badge says the app was deployed and checked.
        </p>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginBottom: "1rem" }}>
          <img src="/deploy-button.svg" alt="Deploy with ShipFix" width={198} height={32} />
          <img src="/badge.svg" alt="Deployed and checked by ShipFix" width={236} height={20} />
        </div>
        <div style={{ display: "grid", gap: 14 }}>
          <CopyBlock label="README button" value={snippets.button} />
          <CopyBlock label="README badge" value={snippets.badge} />
        </div>
      </section>
    </main>
  );
}
