import type { CSSProperties } from "react";

export const colors = {
  bg: "#08090b",
  card: "#101318",
  panel: "#151922",
  panelSoft: "#0d1015",
  border: "#242a34",
  borderStrong: "#343c4a",
  text: "#f3f6fb",
  dim: "#9ca3af",
  muted: "#cbd5e1",
  accent: "#0ea5e9",
  accentText: "#7dd3fc",
  accentBg: "#082f49",
  accentBorder: "#075985",
  success: "#34d399",
  successDeep: "#065f46",
  successBg: "#052e1f",
  successText: "#a7f3d0",
  warn: "#fbbf24",
  warnBg: "#1c1503",
  warnText: "#fcd34d",
  warnBorder: "#7a5a12",
  error: "#f87171",
  errorBg: "#1c0a0a",
  errorBorder: "#7f1d1d",
  errorText: "#fca5a5",
};

export const card: CSSProperties = {
  background: colors.card,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  padding: "1rem",
  boxShadow: "0 18px 48px rgba(0,0,0,0.18)",
};

export const h2: CSSProperties = {
  fontSize: "0.8rem",
  textTransform: "uppercase",
  letterSpacing: 1,
  opacity: 0.6,
  margin: 0,
};

export const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

export const inputStyle: CSSProperties = {
  padding: "0.7rem 0.9rem",
  borderRadius: 8,
  border: `1px solid ${colors.borderStrong}`,
  background: colors.panel,
  color: colors.text,
  fontSize: "0.95rem",
  outline: "none",
};

export function buttonStyle(variant: "primary" | "ghost" | "success" = "primary", disabled = false): CSSProperties {
  const base: CSSProperties = {
    padding: "0.7rem 1.3rem",
    borderRadius: 8,
    fontSize: "0.95rem",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    border: "none",
    opacity: disabled ? 0.6 : 1,
    transition: "background 120ms ease, border-color 120ms ease, opacity 120ms ease",
  };
  if (variant === "ghost") {
    return { ...base, background: colors.panel, color: colors.text, border: `1px solid ${colors.borderStrong}` };
  }
  if (variant === "success") {
    return { ...base, background: colors.success, color: "#04120c" };
  }
  return { ...base, background: colors.accent, color: "#fff" };
}

export const STATE_COLOR: Record<string, string> = {
  live: colors.success,
  failed: colors.error,
  provisioning: colors.warn,
  not_attempted: colors.dim,
};
