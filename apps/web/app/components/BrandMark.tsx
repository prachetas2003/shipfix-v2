"use client";

import { colors } from "../lib/theme";

export function BrandMark({
  size = 34,
  showWordmark = true,
}: {
  size?: number;
  showWordmark?: boolean;
}): React.ReactElement {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          borderRadius: 8,
          border: `1px solid ${colors.border}`,
          background: colors.card,
          display: "inline-grid",
          placeItems: "center",
        }}
      >
        <svg width={Math.round(size * 0.72)} height={Math.round(size * 0.72)} viewBox="0 0 28 28" role="img">
          <title>ShipFix</title>
          <path d="M5 18.5h10.5c3.5 0 6.1-1.8 7.5-5.5H8.5L5 18.5Z" fill={colors.accentText} />
          <path d="M9 11.5h8.5l-2.3-3.8H11L9 11.5Z" fill={colors.text} opacity="0.92" />
          <path
            d="M17.2 19.8 22 15l-4.8-4.8"
            fill="none"
            stroke={colors.success}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {showWordmark && (
        <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1.05 }}>
          <strong style={{ fontSize: "0.95rem", letterSpacing: "-0.02em", fontWeight: 600 }}>ShipFix</strong>
          <span style={{ color: colors.dim, fontSize: "0.68rem", letterSpacing: 0 }}>deployment operator</span>
        </span>
      )}
    </div>
  );
}
