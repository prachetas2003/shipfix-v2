import { randomBytes } from "node:crypto";
import type { DeploymentPlan } from "@shipfix/contracts";
import { projectEnvVars, type Database } from "@shipfix/db";
import type { SecretVault } from "@shipfix/secrets";
import { eq } from "drizzle-orm";

/** Names in the plan that ShipFix must generate (deduped across services). */
export function generatedSecretNames(plan: DeploymentPlan): string[] {
  const names = new Set<string>();
  for (const s of plan.services) {
    for (const e of s.env) if (e.source === "generated_secret") names.add(e.name);
  }
  return [...names].sort();
}

export function newGeneratedSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Create sealed project env values for every `generated_secret` the plan uses
 * and that the project doesn't have yet. Existing values (generated earlier or
 * set by the user) are never replaced, so sessions and signed tokens survive
 * redeploys. Insert-if-absent keeps concurrent runs from racing.
 */
export async function ensureGeneratedSecrets(
  db: Database,
  projectId: string,
  plan: DeploymentPlan,
  vault: SecretVault,
): Promise<string[]> {
  const wanted = generatedSecretNames(plan);
  if (wanted.length === 0) return [];
  const existing = new Set(
    (
      await db
        .select({ name: projectEnvVars.name })
        .from(projectEnvVars)
        .where(eq(projectEnvVars.projectId, projectId))
    ).map((r) => r.name),
  );
  const created: string[] = [];
  for (const name of wanted) {
    if (existing.has(name)) continue;
    const sealed = await vault.seal(newGeneratedSecret());
    const inserted = await db
      .insert(projectEnvVars)
      .values({
        projectId,
        name,
        isSecret: true,
        encBlob: sealed.encBlob,
        encIv: sealed.encIv,
        encDek: sealed.encDek,
      })
      .onConflictDoNothing()
      .returning({ name: projectEnvVars.name });
    if (inserted.length) created.push(name);
  }
  return created;
}
