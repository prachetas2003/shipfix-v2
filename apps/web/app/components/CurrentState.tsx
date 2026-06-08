"use client";

import type { AppResourceDisplay } from "../lib/resourceDisplay";
import { fullStackSummary } from "../lib/resourceDisplay";
import { card, colors, h2, mono, STATE_COLOR } from "../lib/theme";

const STATE_LABEL: Record<string, string> = {
  live: "Live",
  failed: "Failed",
  provisioning: "Provisioning",
  not_attempted: "Not deployed",
};

function StatusPill({ state }: { state: string }): React.ReactElement {
  const color = STATE_COLOR[state] ?? colors.dim;
  return (
    <span
      style={{
        color: "#0b0b0b",
        background: color,
        fontSize: "0.7rem",
        fontWeight: 700,
        padding: "0.1rem 0.55rem",
        borderRadius: 999,
      }}
    >
      {STATE_LABEL[state] ?? state}
    </span>
  );
}

function MetaLine({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <p style={{ margin: "0.25rem 0", fontSize: "0.82rem", opacity: 0.85 }}>
      <span style={{ opacity: 0.6 }}>{label}: </span>
      <code style={{ fontFamily: mono, wordBreak: "break-all" }}>{value}</code>
    </p>
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
      <h2 style={{ ...h2, marginBottom: "0.75rem" }}>Current state</h2>

      {/* Main user-facing app */}
      {frontend && (
        <div
          style={{
            padding: "1rem",
            marginBottom: "1rem",
            borderRadius: 8,
            border: `1px solid ${colors.successDeep}`,
            background: colors.successBg,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: "1rem", color: colors.successText }}>Your app</strong>
            <StatusPill state={frontend.state} />
            {frontend.provider && (
              <span style={{ opacity: 0.65, fontSize: "0.8rem" }}>{frontend.provider}</span>
            )}
          </div>
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", color: colors.successText, opacity: 0.9 }}>
            This is the link you share with users. It loads your UI and talks to the backend and database behind the scenes.
          </p>
          {frontend.openAppUrl ? (
            <a
              href={frontend.openAppUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-block",
                marginTop: "0.75rem",
                padding: "0.55rem 1.2rem",
                borderRadius: 8,
                background: colors.success,
                color: "#0b0b0b",
                fontWeight: 700,
                fontSize: "0.95rem",
                textDecoration: "none",
              }}
            >
              Open app →
            </a>
          ) : (
            <p style={{ margin: "0.5rem 0 0", opacity: 0.7, fontSize: "0.85rem" }}>No frontend URL yet.</p>
          )}
          {frontend.openAppUrl && (
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.78rem", fontFamily: mono, opacity: 0.75, wordBreak: "break-all" }}>
              {frontend.openAppUrl}
            </p>
          )}
        </div>
      )}

      <h3 style={{ ...h2, fontSize: "0.75rem", marginBottom: "0.5rem" }}>Supporting services</h3>

      {backend && (
        <div style={{ padding: "0.75rem 0", borderBottom: `1px solid ${colors.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <strong>Backend API</strong>
            <StatusPill state={backend.state} />
            {backend.provider && <span style={{ opacity: 0.6, fontSize: "0.8rem" }}>{backend.provider}</span>}
          </div>
          <p style={{ margin: "0.35rem 0", fontSize: "0.82rem", opacity: 0.75 }}>
            Powers your frontend with data and health checks. The API root path may return &quot;Cannot GET /&quot; — that is normal when there is no homepage at <code>/</code>.
          </p>
          {backend.baseUrl && <MetaLine label="Service URL" value={backend.baseUrl} />}
          {backend.healthCheckUrl ? (
            <p style={{ margin: "0.35rem 0", fontSize: "0.82rem" }}>
              <span style={{ opacity: 0.6 }}>API health check: </span>
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
                <code style={{ fontFamily: mono }}>{backend.healthCheckUrl}</code>
              )}
              {backend.healthCheckPassed && (
                <span style={{ color: colors.success, marginLeft: 8, fontWeight: 600 }}>passed</span>
              )}
            </p>
          ) : backend.state === "live" ? (
            <p style={{ margin: "0.35rem 0", fontSize: "0.82rem", opacity: 0.6 }}>Health check URL not recorded for this run.</p>
          ) : null}
        </div>
      )}

      {database && (
        <div style={{ padding: "0.75rem 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <strong>Database</strong>
            <StatusPill state={database.state} />
            {database.provider && <span style={{ opacity: 0.6, fontSize: "0.8rem" }}>{database.provider}</span>}
          </div>
          <p style={{ margin: "0.35rem 0", fontSize: "0.82rem", opacity: 0.75 }}>
            Stores your app data. This is infrastructure metadata — not a website you open in a browser.
          </p>
          {database.host && <MetaLine label="Host" value={database.host} />}
          {database.exposesEnv && <MetaLine label="Exposes" value={database.exposesEnv} />}
          <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", opacity: 0.6 }}>
            Connection string: stored securely (sealed). ShipFix never shows it in the UI.
          </p>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, paddingTop: "0.85rem", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600 }}>Full-stack:</span>
        <span style={{ color: display.fullStack.live ? colors.success : colors.warn, fontWeight: 700 }}>
          {display.fullStack.live ? "Live" : "Not live yet"}
        </span>
        <span style={{ opacity: 0.7, fontSize: "0.85rem", flex: 1 }}>{fullStackSummary(display)}</span>
      </div>
    </section>
  );
}
