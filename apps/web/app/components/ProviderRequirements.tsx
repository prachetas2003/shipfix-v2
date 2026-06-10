"use client";

import type { PlanView } from "../lib/api";
import { deriveRequiredProviders, missingProviders } from "../lib/planRequirements";
import { REUSE_NOTE } from "../lib/providerGuide";
import { colors, h2 } from "../lib/theme";
import { ConnectProvider } from "./ConnectProvider";

/**
 * "What ShipFix needs": plan-driven list of required provider connections with
 * plain-language reasons, each rendered as a guided Connect card. Deploy is
 * gated by the caller on `allConnected`.
 */
export function ProviderRequirements({
  plan,
  connected,
  onConnected,
}: {
  plan: PlanView | null;
  connected: string[];
  onConnected: () => void;
}): React.ReactElement {
  const required = deriveRequiredProviders(plan);
  const missing = missingProviders(required, connected);
  const isDeployable = plan?.classification === "deployable";

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2 style={h2}>Connect providers</h2>
      <p style={{ margin: "0.5rem 0 1rem", fontSize: "0.86rem", color: colors.dim, lineHeight: 1.6 }}>
        ShipFix only asks for providers this plan needs. {REUSE_NOTE}
      </p>

      {required.length === 0 && (
        <p style={{ opacity: 0.6, fontSize: "0.88rem" }}>
          No provider connections are required for this plan.
        </p>
      )}

      {required.map((req) => (
        <ConnectProvider
          key={req.provider}
          providerId={req.provider}
          connected={connected.includes(req.provider)}
          reason={req.reason}
          onConnected={onConnected}
        />
      ))}

      {required.length > 0 && (
        <p
          style={{
            margin: "0.5rem 0 0",
            fontSize: "0.85rem",
            fontWeight: 600,
            color: missing.length === 0 && isDeployable ? colors.success : colors.warn,
          }}
        >
          {missing.length > 0
            ? `Still needed: ${missing.map((m) => m.provider).join(", ")}.`
            : isDeployable
              ? "All required providers are connected. You are ready to deploy."
              : "Providers are connected, but this plan still needs the setup items above resolved before it can deploy."}
        </p>
      )}
    </section>
  );
}
