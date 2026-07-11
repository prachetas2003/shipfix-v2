"use client";

import type { ReactNode } from "react";
import type { AppResourceDisplay } from "../lib/resourceDisplay";
import { fullStackSummary, providerConsoleLabel } from "../lib/resourceDisplay";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Panel } from "./ui/Panel";
import { StatusDot } from "./ui/StatusDot";
import { colors, h2, mono } from "../lib/theme";

function providerName(provider: string | null | undefined): string {
  if (!provider) return "";
  if (provider === "vercel") return "Vercel";
  if (provider === "render") return "Render";
  if (provider === "neon") return "Neon";
  return provider;
}

function badgeTone(state: string): "success" | "warn" | "error" | "neutral" | "info" {
  if (state === "live") return "success";
  if (state === "failed") return "error";
  if (state === "provisioning") return "warn";
  return "neutral";
}

function stateLabel(state: string): string {
  if (state === "live") return "Live";
  if (state === "failed") return "Failed";
  if (state === "provisioning") return "In progress";
  return "Not deployed";
}

function MetaLine({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <p style={{ margin: "0.25rem 0", fontSize: "0.8rem", color: colors.muted }}>
      <span style={{ color: colors.dim }}>{label}: </span>
      <code style={{ fontFamily: mono, wordBreak: "break-all", color: colors.text }}>{value}</code>
    </p>
  );
}

function ServiceNode({
  title,
  provider,
  state,
  description,
  children,
}: {
  title: string;
  provider: string | null;
  state: string;
  description: string;
  children?: ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        background: colors.panelSoft,
        padding: "0.85rem 1rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <StatusDot tone={state === "live" ? "live" : state === "failed" ? "failed" : state === "provisioning" ? "provisioning" : "neutral"} />
        <strong style={{ fontSize: "0.92rem", fontWeight: 600 }}>{title}</strong>
        <Badge tone={badgeTone(state)}>{stateLabel(state)}</Badge>
        {provider && <span style={{ color: colors.dim, fontSize: "0.78rem" }}>{providerName(provider)}</span>}
      </div>
      <p style={{ margin: "0.4rem 0 0", fontSize: "0.82rem", color: colors.dim, lineHeight: 1.5 }}>{description}</p>
      {children && <div style={{ marginTop: "0.6rem" }}>{children}</div>}
    </div>
  );
}

export function CurrentState({ display }: { display: AppResourceDisplay }): React.ReactElement {
  const { frontend, backend, database } = display;

  return (
    <Panel>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 style={h2}>Stack</h2>
        <Badge tone={display.fullStack.live ? "success" : "warn"}>
          {display.fullStack.live ? "Full-stack live" : "Not proven live"}
        </Badge>
      </div>

      <div style={{ display: "grid", gap: 10, marginTop: "0.9rem" }}>
        {frontend && (
          <ServiceNode
            title="Frontend"
            provider={frontend.provider}
            state={frontend.state}
            description="User-facing app."
          >
            {frontend.openAppUrl ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <a href={frontend.openAppUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                  <Button variant="success">Open app</Button>
                </a>
                {frontend.consoleUrl && (
                  <a href={frontend.consoleUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                    <Button variant="ghost">{providerConsoleLabel(frontend.provider)}</Button>
                  </a>
                )}
              </div>
            ) : (
              <p style={{ margin: 0, color: colors.dim, fontSize: "0.82rem" }}>No URL yet.</p>
            )}
          </ServiceNode>
        )}

        {backend && (
          <ServiceNode
            title="Backend API"
            provider={backend.provider}
            state={backend.state}
            description="API for the frontend."
          >
            {backend.baseUrl && <MetaLine label="URL" value={backend.baseUrl} />}
            {backend.healthCheckUrl && (
              <p style={{ margin: "0.25rem 0", fontSize: "0.8rem", color: colors.muted }}>
                <span style={{ color: colors.dim }}>Health: </span>
                {backend.healthCheckPassed ? (
                  <a
                    href={backend.healthCheckUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: colors.accentText, fontFamily: mono, wordBreak: "break-all" }}
                  >
                    {backend.healthCheckUrl}
                  </a>
                ) : (
                  <code style={{ fontFamily: mono, wordBreak: "break-all" }}>{backend.healthCheckUrl}</code>
                )}
                {backend.healthCheckPassed && (
                  <span style={{ color: colors.success, marginLeft: 8, fontWeight: 600 }}>passed</span>
                )}
              </p>
            )}
            {backend.consoleUrl && (
              <a href={backend.consoleUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                <Button variant="ghost">{providerConsoleLabel(backend.provider)}</Button>
              </a>
            )}
          </ServiceNode>
        )}

        {database && (
          <ServiceNode
            title="Database"
            provider={database.provider}
            state={database.state}
            description="Postgres for the backend. Connection string stays sealed."
          >
            {database.host && <MetaLine label="Host" value={database.host} />}
            {database.exposesEnv && <MetaLine label="Env" value={database.exposesEnv} />}
            {database.consoleUrl && (
              <a href={database.consoleUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                <Button variant="ghost">{providerConsoleLabel(database.provider)}</Button>
              </a>
            )}
          </ServiceNode>
        )}
      </div>

      <p style={{ margin: "0.9rem 0 0", color: colors.muted, fontSize: "0.85rem", lineHeight: 1.5 }}>
        {fullStackSummary(display)}
      </p>
    </Panel>
  );
}
