import type { PlanProvider, ServiceType } from "@shipfix/contracts";

/** Managed-service providers ShipFix could provision (see DeploymentPlan). */
export type ManagedProvider = "neon" | "supabase" | "upstash";

/**
 * What the running system can ACTUALLY execute right now — derived from the
 * live adapter/provisioner registries, never from the plan or the LLM.
 *
 * The validator uses this to mark provider choices "unavailable" and downgrade
 * classification. In this build there are no adapters, so capabilities are
 * empty and every otherwise-deployable plan becomes `diagnose_only`.
 */
export interface Capabilities {
  /** provider -> the service types its adapter can deploy. */
  readonly providers: ReadonlyMap<PlanProvider, ReadonlySet<ServiceType>>;
  /** managed providers a provisioner can create. */
  readonly managedProviders: ReadonlySet<ManagedProvider>;
}

/** No deploy/provision capability (the current reality of this build). */
export function emptyCapabilities(): Capabilities {
  return { providers: new Map(), managedProviders: new Set() };
}

/** Type-safe builder, handy for the worker activity and tests. */
export function capabilities(
  providerServiceTypes: Partial<Record<PlanProvider, ServiceType[]>>,
  managedProviders: ManagedProvider[] = [],
): Capabilities {
  const providers = new Map<PlanProvider, ReadonlySet<ServiceType>>();
  for (const [provider, types] of Object.entries(providerServiceTypes)) {
    if (types) providers.set(provider as PlanProvider, new Set(types));
  }
  return { providers, managedProviders: new Set(managedProviders) };
}
