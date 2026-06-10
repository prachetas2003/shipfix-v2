/**
 * Derive which provider connections a validated plan actually needs, and why,
 * in plain language. This drives the "What ShipFix needs" wizard step so a
 * beginner never has to guess which keys to set up before deploying.
 */

import type { ProviderId } from "./providerGuide";

export interface PlanServiceLite {
  id: string;
  type: string;
  provider?: string | null;
}
export interface PlanManagedLite {
  id?: string;
  kind?: string;
  provider?: string | null;
  exposesEnv?: string;
}
export interface PlanLite {
  services?: PlanServiceLite[];
  managed?: PlanManagedLite[];
  managedServices?: PlanManagedLite[];
}

export interface ProviderRequirement {
  provider: ProviderId;
  reason: string;
}

/** Map plan services + managed resources to required providers with reasons. */
export function deriveRequiredProviders(plan: PlanLite | null): ProviderRequirement[] {
  if (!plan) return [];
  const reqs = new Map<ProviderId, string>();

  const managed = plan.managed ?? plan.managedServices ?? [];
  for (const m of managed) {
    if (m.provider === "neon" || m.kind === "postgres" || m.exposesEnv === "DATABASE_URL") {
      reqs.set(
        "neon",
        `Neon is needed because a Postgres database${
          m.exposesEnv ? ` (${m.exposesEnv})` : ""
        } was detected.`,
      );
    }
  }

  for (const s of plan.services ?? []) {
    if (s.provider === "render" || s.type === "node_api") {
      reqs.set("render", "Render is needed because a backend service was detected.");
    }
    if (s.provider === "vercel" || s.type === "frontend_static") {
      reqs.set("vercel", "Vercel is needed because a frontend static app was detected.");
    }
  }

  const order: ProviderId[] = ["neon", "render", "vercel"];
  return order.filter((p) => reqs.has(p)).map((p) => ({ provider: p, reason: reqs.get(p)! }));
}

/** Providers required but not yet connected; these block Deploy. */
export function missingProviders(
  required: ProviderRequirement[],
  connected: string[],
): ProviderRequirement[] {
  const have = new Set(connected);
  return required.filter((r) => !have.has(r.provider));
}
