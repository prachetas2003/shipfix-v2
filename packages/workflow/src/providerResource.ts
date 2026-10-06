import { and, desc, eq } from "drizzle-orm";
import { deployedResources, runs, type Database } from "@shipfix/db";

export interface PersistedProviderResource {
  externalId: string;
  url: string | null;
  status: string;
}

/**
 * Stable provider resource name keyed by ShipFix project + service (not run).
 * Keeps Vercel/Render create-or-update idempotent across retries and redeploys.
 */
export function stableProviderResourceName(
  projectId: string,
  serviceId: string,
  maxLen = 52,
): string {
  const pid = projectId.replace(/-/g, "").slice(0, 12);
  return `sf-${pid}-${serviceId}`.slice(0, maxLen);
}

/**
 * Most recent deployed_resources row for this ShipFix project/service/provider
 * that recorded a provider external id (live or failed attempts).
 */
export async function findPersistedProviderResource(
  db: Database,
  args: { projectId: string; serviceId: string; provider: string },
): Promise<PersistedProviderResource | null> {
  const projectRuns = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.projectId, args.projectId));
  const runIds = new Set(projectRuns.map((r) => r.id));
  if (runIds.size === 0) return null;

  const rows = await db
    .select({
      runId: deployedResources.runId,
      externalId: deployedResources.externalId,
      url: deployedResources.url,
      status: deployedResources.status,
    })
    .from(deployedResources)
    .where(
      and(
        eq(deployedResources.serviceId, args.serviceId),
        eq(deployedResources.provider, args.provider),
      ),
    )
    .orderBy(desc(deployedResources.createdAt));

  for (const row of rows) {
    if (row.externalId && runIds.has(row.runId)) {
      return {
        externalId: row.externalId,
        url: row.url,
        status: row.status,
      };
    }
  }
  return null;
}

export type DeployedResourceRecord = typeof deployedResources.$inferSelect;

/**
 * Most recent live, sealed managed resource (e.g. a Neon database) for this project
 * from a previous run. Managed data must survive redeploys, so provisioning reuses it
 * instead of creating an empty database per run.
 */
export async function findReusableManagedResource(
  db: Database,
  args: { projectId: string; serviceId: string; provider: string; excludeRunId?: string },
): Promise<DeployedResourceRecord | null> {
  const rows = await db
    .select({ resource: deployedResources })
    .from(deployedResources)
    .innerJoin(runs, eq(runs.id, deployedResources.runId))
    .where(
      and(
        eq(runs.projectId, args.projectId),
        eq(deployedResources.serviceId, args.serviceId),
        eq(deployedResources.provider, args.provider),
        eq(deployedResources.status, "live"),
      ),
    )
    .orderBy(desc(deployedResources.createdAt));

  for (const { resource } of rows) {
    if (args.excludeRunId && resource.runId === args.excludeRunId) continue;
    if (resource.externalId && resource.encBlob && resource.encIv && resource.encDek) return resource;
  }
  return null;
}

export async function resolveProviderDeployTarget(
  db: Database,
  projectId: string,
  serviceId: string,
  provider: string,
  maxNameLen: number,
): Promise<{ resourceName: string; existingExternalId?: string }> {
  const resourceName = stableProviderResourceName(projectId, serviceId, maxNameLen);
  const persisted = await findPersistedProviderResource(db, {
    projectId,
    serviceId,
    provider,
  });
  if (!persisted?.externalId) return { resourceName };
  return { resourceName, existingExternalId: persisted.externalId };
}
