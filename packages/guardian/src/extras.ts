export interface OwnedResource {
  provider: string;
  externalId: string;
  kind: string;
  serviceId: string;
}

export interface TeardownStep {
  provider: string;
  externalId: string;
  kind: string;
  serviceId: string;
  action: "delete" | "skip";
  reason: string | null;
}

const DELETE_PROVIDERS = new Set(["vercel", "render", "neon", "upstash"]);

function teardownRank(resource: OwnedResource): number {
  if (resource.provider === "vercel" || resource.provider === "render" || resource.kind === "service") return 0;
  if (resource.provider === "upstash") return 1;
  return 2;
}

/** Services go first, then Redis, then databases. Supabase projects are never deleted. */
export function planTeardown(resources: OwnedResource[]): TeardownStep[] {
  const seen = new Set<string>();
  const steps: TeardownStep[] = [];
  for (const resource of [...resources].sort((a, b) => teardownRank(a) - teardownRank(b))) {
    if (!resource.externalId) continue;
    const key = `${resource.provider}:${resource.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (resource.provider === "supabase") {
      steps.push({ ...resource, action: "skip", reason: "ShipFix does not delete a Supabase project." });
      continue;
    }
    if (!DELETE_PROVIDERS.has(resource.provider)) {
      steps.push({ ...resource, action: "skip", reason: "ShipFix has no teardown for this host." });
      continue;
    }
    steps.push({ ...resource, action: "delete", reason: null });
  }
  return steps;
}

export function backupTarget(resources: OwnedResource[]): { provider: "neon" | "supabase"; externalId: string } | null {
  const neon = resources.find((resource) => resource.provider === "neon" && resource.externalId);
  if (neon) return { provider: "neon", externalId: neon.externalId };
  const supabase = resources.find((resource) => resource.provider === "supabase" && resource.externalId);
  if (supabase) return { provider: "supabase", externalId: supabase.externalId };
  return null;
}

/** A frontend host when one is recorded, otherwise the Render service. */
export function domainTarget(resources: OwnedResource[]): { provider: "vercel" | "render"; externalId: string } | null {
  const vercel = resources.find((resource) => resource.provider === "vercel" && resource.externalId);
  if (vercel) return { provider: "vercel", externalId: vercel.externalId };
  const render = resources.find((resource) => resource.provider === "render" && resource.kind === "service" && resource.externalId);
  if (render) return { provider: "render", externalId: render.externalId };
  return null;
}

export function validHostname(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null;
  return host;
}

export const ONE_ENVIRONMENT_NOTE =
  "This app has one environment, production. A pull-request preview is not started, because another deploy updates the same Vercel project and Render service. ShipFix does not open a database branch for each pull request.";

export interface ProviderCreds {
  vercelToken?: string;
  vercelTeamId?: string;
  renderKey?: string;
  neonKey?: string;
  upstashEmail?: string;
  upstashKey?: string;
}

async function call(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8_000) });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

/** Deletes one recorded resource. A 404 counts as already gone. The response body is not returned. */
export async function deleteProviderResource(
  step: TeardownStep,
  creds: ProviderCreds,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; line: string }> {
  if (step.action === "skip") return { ok: true, line: `${step.provider} ${step.externalId}: ${step.reason}` };
  let status = 0;
  if (step.provider === "vercel" && creds.vercelToken) {
    const team = creds.vercelTeamId ? `?teamId=${encodeURIComponent(creds.vercelTeamId)}` : "";
    status = (await call(fetchImpl, `https://api.vercel.com/v9/projects/${encodeURIComponent(step.externalId)}${team}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${creds.vercelToken}` },
    })).status;
  } else if (step.provider === "render" && creds.renderKey) {
    status = (await call(fetchImpl, `https://api.render.com/v1/services/${encodeURIComponent(step.externalId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${creds.renderKey}`, accept: "application/json" },
    })).status;
  } else if (step.provider === "neon" && creds.neonKey) {
    status = (await call(fetchImpl, `https://console.neon.tech/api/v2/projects/${encodeURIComponent(step.externalId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${creds.neonKey}`, accept: "application/json" },
    })).status;
  } else if (step.provider === "upstash" && creds.upstashEmail && creds.upstashKey) {
    const auth = `Basic ${Buffer.from(`${creds.upstashEmail}:${creds.upstashKey}`).toString("base64")}`;
    status = (await call(fetchImpl, `https://api.upstash.com/v2/redis/database/${encodeURIComponent(step.externalId)}`, {
      method: "DELETE",
      headers: { authorization: auth, accept: "application/json" },
    })).status;
  } else {
    return { ok: false, line: `${step.provider} is connected without the credential teardown needs.` };
  }
  const gone = (status >= 200 && status < 300) || status === 404;
  return {
    ok: gone,
    line: gone
      ? `Removed ${step.provider} ${step.externalId}.`
      : `Could not remove ${step.provider} ${step.externalId} (HTTP ${status || "network"}).`,
  };
}

export async function attachHostname(
  target: { provider: "vercel" | "render"; externalId: string },
  hostname: string,
  creds: ProviderCreds,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; lines: string[] }> {
  if (target.provider === "vercel") {
    if (!creds.vercelToken) return { ok: false, lines: ["Vercel is connected without a token, so the domain was not attached."] };
    const team = creds.vercelTeamId ? `?teamId=${encodeURIComponent(creds.vercelTeamId)}` : "";
    const res = await call(
      fetchImpl,
      `https://api.vercel.com/v10/projects/${encodeURIComponent(target.externalId)}/domains${team}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${creds.vercelToken}`, "content-type": "application/json" },
        body: JSON.stringify({ name: hostname }),
      },
    );
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, lines: [`Vercel did not attach ${hostname} (HTTP ${res.status || "network"}).`] };
    }
    const lines = [`Vercel accepted ${hostname} on project ${target.externalId}. TLS is issued by Vercel after the DNS records are in place.`];
    const row = res.body as { verified?: unknown; verification?: unknown } | null;
    if (row && row.verified === false && Array.isArray(row.verification)) {
      for (const item of row.verification) {
        if (!item || typeof item !== "object") continue;
        const record = item as { type?: unknown; domain?: unknown; value?: unknown };
        if (typeof record.type === "string" && typeof record.domain === "string" && typeof record.value === "string") {
          lines.push(`Add a ${record.type} record on ${record.domain} with value ${record.value}.`);
        }
      }
    }
    return { ok: true, lines };
  }
  if (!creds.renderKey) return { ok: false, lines: ["Render is connected without an API key, so the domain was not attached."] };
  const res = await call(fetchImpl, `https://api.render.com/v1/services/${encodeURIComponent(target.externalId)}/custom-domains`, {
    method: "POST",
    headers: { authorization: `Bearer ${creds.renderKey}`, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ name: hostname }),
  });
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, lines: [`Render did not attach ${hostname} (HTTP ${res.status || "network"}).`] };
  }
  return { ok: true, lines: [`Render accepted ${hostname} on service ${target.externalId}. TLS is issued by Render after the DNS record is in place.`] };
}
