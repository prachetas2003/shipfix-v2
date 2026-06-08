import type { ManagedKind, PlanProvider, ServiceType } from "@shipfix/contracts";
import type { ManagedProvider } from "./capabilities";

/**
 * The MVP-supported slice ShipFix can actually auto-deploy, independent of which
 * providers a given user has connected. This is the honesty boundary: anything
 * outside this matrix is diagnosed, never silently "deployed".
 *
 * Keep this in lockstep with the real adapters/provisioners. Adding a value here
 * without a working adapter recreates the "support illusion" that sank v1.
 */
export const MVP_SERVICE_SUPPORT: Readonly<Record<string, ReadonlyArray<ServiceType>>> = {
  render: ["node_api"],
  vercel: ["frontend_static"],
};

export const MVP_MANAGED_SUPPORT: Readonly<Record<string, ReadonlyArray<ManagedKind>>> = {
  neon: ["postgres"],
};

/** True when ShipFix can auto-deploy this provider+service type in the MVP. */
export function isServiceTypeSupported(provider: PlanProvider, type: ServiceType): boolean {
  return MVP_SERVICE_SUPPORT[provider]?.includes(type) ?? false;
}

/** True when ShipFix can provision this managed provider+kind in the MVP. */
export function isManagedSupported(provider: ManagedProvider, kind: ManagedKind): boolean {
  return MVP_MANAGED_SUPPORT[provider]?.includes(kind) ?? false;
}

/** Short human-readable description of the MVP-supported slice (for UI/copy). */
export const MVP_SUPPORT_SUMMARY =
  "Vite/static frontends on Vercel, Node APIs on Render, and Postgres on Neon.";
