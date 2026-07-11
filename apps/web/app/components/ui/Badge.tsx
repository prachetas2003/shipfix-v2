"use client";

import type { ReactNode } from "react";

type Tone = "success" | "warn" | "error" | "neutral" | "info";

export function Badge({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return <span className={`sf-badge sf-badge--${tone} ${className}`.trim()}>{children}</span>;
}
