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
