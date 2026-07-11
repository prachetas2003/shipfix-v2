"use client";

export function Skeleton({
  height = 16,
  width = "100%",
  className = "",
}: {
  height?: number | string;
  width?: number | string;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={`sf-skeleton ${className}`.trim()}
      style={{ height, width }}
      aria-hidden
    />
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      className="sf-panel sf-fade-in"
      style={{ textAlign: "center", padding: "2.5rem 1.5rem" }}
    >
      <p style={{ margin: 0, fontWeight: 600, fontSize: "1rem" }}>{title}</p>
      {detail && (
        <p style={{ margin: "0.5rem auto 0", color: "var(--sf-dim)", fontSize: "0.88rem", maxWidth: 420, lineHeight: 1.55 }}>
          {detail}
        </p>
      )}
      {action && <div style={{ marginTop: "1.25rem" }}>{action}</div>}
    </div>
  );
}
