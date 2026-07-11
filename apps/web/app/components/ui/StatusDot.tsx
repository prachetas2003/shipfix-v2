"use client";

import { colors } from "../../lib/theme";

const TONE: Record<string, string> = {
  success: colors.success,
  warn: colors.warn,
  error: colors.error,
  neutral: colors.dim,
  info: colors.accentText,
  live: colors.success,
  failed: colors.error,
  provisioning: colors.warn,
  progress: colors.accentText,
};

export function StatusDot({
  tone = "neutral",
  title,
}: {
  tone?: keyof typeof TONE | string;
  title?: string;
}): React.ReactElement {
  return (
    <span
      className="sf-status-dot"
      title={title}
      style={{ background: TONE[tone] ?? colors.dim }}
      aria-hidden={!title}
    />
  );
}
