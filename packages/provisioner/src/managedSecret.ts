import { parseNeonConnectionSecret, runtimeConnectionUrl } from "./neonConnections";
import { parseUpstashSecret } from "./upstash";

/**
 * The runtime value of one field of a sealed managed-service secret, or null
 * when that kind of resource has no such field. Postgres exposes
 * connectionUrl (pooled); Upstash Redis also exposes restUrl + restToken.
 */
export function managedSecretField(secret: string, field: string): string | null {
  const upstash = parseUpstashSecret(secret);
  if (upstash) {
    if (field === "connectionUrl") return upstash.url;
    if (field === "restUrl") return upstash.restUrl;
    if (field === "restToken") return upstash.restToken;
    return null;
  }
  if (field !== "connectionUrl") return null;
  return runtimeConnectionUrl(parseNeonConnectionSecret(secret));
}

export function isRedisSecret(secret: string): boolean {
  return parseUpstashSecret(secret) !== null;
}
