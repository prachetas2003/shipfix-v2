"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "../BrandMark";
import { colors } from "../../lib/theme";

export function Shell({
  children,
  wide = false,
}: {
  children: ReactNode;
  wide?: boolean;
}): React.ReactElement {
  return (
    <div className="sf-shell" style={wide ? { maxWidth: 1080 } : undefined}>
      {children}
    </div>
  );
}

export function AppNav({
  right,
}: {
  right?: ReactNode;
}): React.ReactElement {
  return (
    <header
      className="sf-nav"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        marginBottom: "2rem",
        paddingBottom: "1rem",
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      <Link href="/" style={{ textDecoration: "none", color: "inherit" }}>
        <BrandMark size={28} />
      </Link>
      <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>{right}</div>
    </header>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}): React.ReactElement {
  return (
    <div className="sf-page-header">
      <div style={{ flex: "1 1 480px", minWidth: 0 }}>
        {eyebrow}
        <h1
          className="sf-display"
          style={{
            fontSize: "1.7rem",
            margin: eyebrow ? "0.5rem 0 0" : 0,
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <div style={{ margin: "0.45rem 0 0", color: colors.dim, fontSize: "0.9rem", lineHeight: 1.55 }}>
            {subtitle}
          </div>
        )}
      </div>
      {actions && (
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {actions}
        </div>
      )}
    </div>
  );
}
