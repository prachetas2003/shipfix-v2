const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Hostnames that are safe to pass into a DNS lookup command. */
export function safeLookupHosts(hosts: string[]): string[] {
  const out = new Set<string>();
  for (const host of hosts) {
    const value = host.trim().toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(value) || !value.includes(".") || value.startsWith(".") || value.endsWith(".")) continue;
    out.add(value);
  }
  return [...out];
}

function isIpv6(value: string): boolean {
  if (!value.includes(":") || value.length > 45 || value.includes(":::")) return false;
  if (!/^[0-9a-f:]+$/i.test(value)) return false;
  return value.split("::").length <= 2;
}

/** Keep only IP addresses from resolver output. Everything else is ignored. */
export function parseResolvedAddresses(stdout: string): string[] {
  const found = new Set<string>();
  for (const token of stdout.split(/\s+/)) {
    const value = token.trim();
    if (IPV4.test(value) || isIpv6(value)) found.add(value);
  }
  return [...found];
}
