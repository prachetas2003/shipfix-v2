"use client";

import type { ReactNode } from "react";
import type { AppResourceDisplay } from "../lib/resourceDisplay";
import { fullStackSummary } from "../lib/resourceDisplay";
import { buttonStyle, card, colors, h2, mono, STATE_COLOR } from "../lib/theme";

const STATE_LABEL: Record<string, string> = {
  live: "Live",
  failed: "Failed",
  provisioning: "In progress",
  not_attempted: "Not deployed",
};

function providerName(provider: string | null | undefined): string {
  if (!provider) return "";
  if (provider === "vercel") return "Vercel";
  if (provider === "render") return "Render";
  if (provider === "neon") return "Neon";
  return provider;
}

function StatusPill({ state }: { state: string }): React.ReactElement {
  const color = STATE_COLOR[state] ?? colors.dim;
  return (
    <span
      style={{
        color: "#061014",
        background: color,
        fontSize: "0.72rem",
        fontWeight: 800,
        padding: "0.14rem 0.58rem",
        borderRadius: 999,
      }}
    >
      {STATE_LABEL[state] ?? state}
    </span>
  );
}

function MetaLine({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <p style={{ margin: "0.28rem 0", fontSize: "0.82rem", color: colors.muted }}>
      <span style={{ color: colors.dim }}>{label}: </span>
      <code style={{ fontFamily: mono, wordBreak: "break-all", color: colors.text }}>{value}</code>
    </p>
  );
}

function ServicePanel({
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
  const color = STATE_COLOR[state] ?? colors.dim;
  return (
    <div
      style={{
        border: `1px solid ${state === "live" ? colors.successDeep : colors.border}`,
        borderLeft: `4px solid ${color}`,
        borderRadius: 8,
        background: colors.panelSoft,
        padding: "0.9rem 1rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: "0.98rem" }}>{title}</strong>
        <StatusPill state={state} />
        {provider && <span style={{ color: colors.dim, fontSize: "0.8rem" }}>{providerName(provider)}</span>}
      </div>
      <p style={{ margin: "0.45rem 0 0", fontSize: "0.84rem", color: colors.dim, lineHeight: 1.55 }}>
        {description}
      </p>
      {children && <div style={{ marginTop: "0.65rem" }}>{children}</div>}
    </div>
  );
}

/**
 * Resource-type-aware "Current state": frontend is the main app; backend and
 * database are supporting infrastructure with appropriate link behavior.
 */
export function CurrentState({ display }: { display: AppResourceDisplay }): React.ReactElement {
  const { frontend, backend, database } = display;

  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 style={h2}>Current state</h2>
        <span style={{ color: display.fullStack.live ? colors.success : colors.warn, fontWeight: 800, fontSize: "0.86rem" }}>
          {display.fullStack.live ? "Full-stack live" : "Not proven live yet"}
        </span>
      </div>

      <div style={{ display: "grid", gap: 12, marginTop: "1rem" }}>
        {frontend && (
          <ServicePanel
            title="Frontend app"
            provider={frontend.provider}
            state={frontend.state}
            description="This is the user-facing app link. It should load in a browser and call the backend through the configured API URL."
          >
            {frontend.openAppUrl ? (
              <>
                <a
                  href={frontend.openAppUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ ...buttonStyle("success"), textDecoration: "none", display: "inline-block" }}
                >
                  Open app
                </a>
                <p style={{ margin: "0.55rem 0 0", fontSize: "0.78rem", fontFamily: mono, color: colors.dim, wordBreak: "break-all" }}>
                  {frontend.openAppUrl}
                </p>
              </>
            ) : (
              <p style={{ margin: 0, color: colors.dim, fontSize: "0.84rem" }}>No frontend URL recorded yet.</p>
            )}
          </ServicePanel>
        )}

        {backend && (
          <ServicePanel
            title="Backend API"
            provider={backend.provider}
            state={backend.state}
            description='This powers your frontend. The API root path can show "Cannot GET /" and still be healthy if the health check passes.'
          >
            {backend.baseUrl && <MetaLine label="Service URL" value={backend.baseUrl} />}
            {backend.healthCheckUrl ? (
              <p style={{ margin: "0.28rem 0", fontSize: "0.82rem", color: colors.muted }}>
                <span style={{ color: colors.dim }}>Health check: </span>
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
                  <span style={{ color: colors.success, marginLeft: 8, fontWeight: 700 }}>passed</span>
                )}
              </p>
            ) : backend.state === "live" ? (
              <p style={{ margin: 0, color: colors.dim, fontSize: "0.84rem" }}>Health check URL was not recorded for this run.</p>
            ) : null}
          </ServicePanel>
        )}

        {database && (
          <ServicePanel
            title="Database"
            provider={database.provider}
            state={database.state}
            description="This is infrastructure for your backend, not a website. ShipFix stores the connection string securely and only shows safe metadata."
          >
            {database.host && <MetaLine label="Host" value={database.host} />}
            {database.exposesEnv && <MetaLine label="Backend env" value={database.exposesEnv} />}
            <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", color: colors.dim }}>
              Connection string is sealed and never shown in the browser.
            </p>
          </ServicePanel>
        )}
      </div>

      <div style={{ borderTop: `1px solid ${colors.border}`, marginTop: "1rem", paddingTop: "0.85rem" }}>
        <p style={{ margin: 0, color: colors.muted, fontSize: "0.9rem", lineHeight: 1.55 }}>
          <strong style={{ color: colors.text }}>Full-stack result: </strong>
          {fullStackSummary(display)}
        </p>
      </div>
    </section>
  );
}
