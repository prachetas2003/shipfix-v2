import type { CSSProperties } from "react";

/**
 * ShipFix design tokens — calm, Railway-inspired restraint.
 * Prefer CSS variables in components; these JS exports keep older call sites working.
 */

export const colors = {
  bg: "#090a0d",
  card: "#12141a",
  panel: "#161922",
  panelSoft: "#0e1015",
  border: "#262a34",
  borderStrong: "#343a48",
  text: "#f3f5f8",
  dim: "#8e95a3",
  muted: "#c0c6d2",
  accent: "#5b9fd4",
  accentText: "#9fd0ef",
  accentBg: "#121a24",
  accentBorder: "#2a4058",
  success: "#3ecf8e",
  successDeep: "#1a5c40",
  successBg: "#0d1f17",
  successText: "#9ae6c0",
  warn: "#e6b84d",
  warnBg: "#1a1608",
  warnText: "#f0d48a",
  warnBorder: "#5c4a1a",
  error: "#e57373",
  errorBg: "#1a0f0f",
  errorBorder: "#5c2a2a",
  errorText: "#f0a8a8",
};

/** Flat panel — hairline border, no multi-layer shadow. */
export const card: CSSProperties = {
  background: colors.card,
  border: `1px solid ${colors.border}`,
  borderRadius: 10,
  padding: "1rem",
};

export const h2: CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: colors.dim,
  margin: 0,
};

export const mono = "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace";
export const sans = "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif";

export const inputStyle: CSSProperties = {
  padding: "0.6rem 0.85rem",
  borderRadius: 8,
  border: `1px solid ${colors.borderStrong}`,
  background: colors.panelSoft,
  color: colors.text,
  fontSize: "0.9rem",
  outline: "none",
};

/** @deprecated Prefer <Button /> from ui/Button. Kept for gradual migration. */
export function buttonStyle(variant: "primary" | "ghost" | "success" = "primary", disabled = false): CSSProperties {
  const base: CSSProperties = {
    padding: "0.55rem 1.1rem",
    borderRadius: 8,
    fontSize: "0.875rem",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    border: "1px solid transparent",
    opacity: disabled ? 0.5 : 1,
    transition: "transform 120ms ease, background 120ms ease, border-color 120ms ease",
  };
  if (variant === "ghost") {
    return {
      ...base,
      background: "transparent",
      color: colors.text,
      border: `1px solid ${colors.borderStrong}`,
    };
  }
  if (variant === "success") {
    return {
      ...base,
      background: colors.success,
      color: "#04120c",
    };
  }
  return {
    ...base,
    background: colors.accent,
    color: "#0a0c10",
  };
}

export const STATE_COLOR: Record<string, string> = {
  live: colors.success,
  failed: colors.error,
  provisioning: colors.warn,
  not_attempted: colors.dim,
};
