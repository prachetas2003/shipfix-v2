"use client";

import { useState } from "react";
import type { PlanView, RunEventRow } from "../lib/api";
import { deriveRequiredProviders } from "../lib/planRequirements";
import { providerGuide, type ProviderId } from "../lib/providerGuide";
import { buttonStyle, card, colors } from "../lib/theme";
import { ConnectProvider } from "./ConnectProvider";

const PROVIDER_EVENTS = new Set([
  "deploy_setup_blocker",
  "deploy_provider_limit",
  "deploy_needs_credential",
  "deploy_provider_env_conflict",
]);

const CREDENTIAL_ACTIONS = new Set([
  "update_credentials",
  "fix_account_setup",
  "resolve_provider_limit",
  "resolve_env_conflict",
]);

/** Providers that failed for credential/account reasons (even if already "connected"). */
export function providersNeedingCredentialFix(events: RunEventRow[]): ProviderId[] {
  const found = new Set<ProviderId>();
  for (const ev of events) {
    const d = ev.data ?? {};
    const event = typeof d.event === "string" ? d.event : "";
    const provider = typeof d.provider === "string" ? d.provider : "";
    const action = typeof d.action === "string" ? d.action : "";
    const detail = `${typeof d.detail === "string" ? d.detail : ""} ${typeof d.whatHappened === "string" ? d.whatHappened : ""} ${ev.message}`;
    const isProviderIssue =
      PROVIDER_EVENTS.has(event) ||
      (event === "deploy_failure_guidance" && CREDENTIAL_ACTIONS.has(action)) ||
      (event === "deploy_failed" &&
        /permission|HTTP 401|HTTP 403|unauthorized|forbidden|token|teamId|GitHub connection/i.test(detail));
    if (!isProviderIssue) continue;
    if (provider === "vercel" || provider === "render" || provider === "neon") {
      found.add(provider);
    }
  }
  return [...found];
}

/**
 * After a deploy fails on provider credentials/permissions, show only the
 * failing connector(s) with an Update path — not a full reconnect of every provider.
 */
export function ProviderCredentialFix({
  events,
  plan,
  connected,
  onUpdated,
  onRetryDeploy,
  retrying,
}: {
  events: RunEventRow[];
  plan: PlanView | null;
  connected: string[];
  onUpdated: () => void;
  onRetryDeploy?: () => void;
  retrying?: boolean;
}): React.ReactElement | null {
  const focus = providersNeedingCredentialFix(events);
  if (focus.length === 0) return null;

  const required = deriveRequiredProviders(plan);
  const reasonByProvider = new Map(required.map((r) => [r.provider, r.reason]));

  return (
    <section
      style={{
        ...card,
        marginTop: "1.5rem",
        borderColor: colors.warnBorder,
        background: colors.warnBg,
      }}
    >
      <h3 style={{ margin: "0 0 0.35rem", fontSize: "1rem", color: colors.warnText }}>
        Update provider credentials
      </h3>
      <p style={{ margin: "0 0 0.9rem", fontSize: "0.88rem", color: colors.warnText, lineHeight: 1.55 }}>
        This failure is a provider account/token issue, not a bug in your repo. Update only the
        connector below, then retry deploy — you do not need to reconnect Neon or Render again.
      </p>

      {focus.map((providerId) => {
        const guide = providerGuide(providerId);
        return (
          <ConnectProvider
            key={providerId}
            providerId={providerId}
            connected={connected.includes(providerId)}
            allowUpdate
            initiallyEditing
            reason={
              reasonByProvider.get(providerId) ??
              (guide
                ? `${guide.name} rejected the last deploy. Paste a fresh token${providerId === "vercel" ? " (and teamId if you use a Vercel team)" : ""}.`
                : undefined)
            }
            onConnected={onUpdated}
          />
        );
      })}

      {onRetryDeploy && (
        <div style={{ marginTop: 8 }}>
          <button onClick={onRetryDeploy} disabled={retrying} style={buttonStyle("primary", retrying)}>
            {retrying ? "Starting..." : "Retry deploy after updating"}
          </button>
        </div>
      )}
    </section>
  );
}
