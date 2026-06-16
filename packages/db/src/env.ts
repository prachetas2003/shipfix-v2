import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { config as loadEnvFile, type DotenvConfigOutput } from "dotenv";

export interface ShipfixEnvLoadOptions {
  /** Absolute path to repo-root `.env`. */
  rootEnvPath: string;
  /** Absolute path to app-local `.env.local` (e.g. `apps/api/.env.local`). */
  appLocalEnvPath: string;
  /**
   * In local dev, prefer the repo-root `.env` over stale shell exports so API
   * and worker restart onto the same control-plane database. Production should
   * leave this false so platform env vars remain authoritative.
   */
  rootOverride?: boolean;
}

export interface ShipfixEnvLoadResult {
  rootEnvPath: string;
  appLocalEnvPath: string;
  rootEnvExists: boolean;
  appLocalEnvExists: boolean;
  rootEnvLoaded: boolean;
  appLocalEnvLoaded: boolean;
  rootEnvOverride: boolean;
  appLocalEnvOverride: boolean;
  /** Human-readable summary of which files contributed (no secrets). */
  envSourcePath: string;
}

export interface DatabaseFingerprint {
  databaseUrlPresent: boolean;
  hostHash: string | null;
  hostRedacted: string | null;
  databaseName: string | null;
}

/**
 * Load ShipFix env the same way in API and worker: repo-root `.env` first, then
 * app-local `.env.local` overrides. Local dev callers can opt into rootOverride
 * to avoid stale shell DATABASE_URL/Temporal settings splitting API and worker
 * across different control-plane databases.
 */
export function loadShipfixEnv(options: ShipfixEnvLoadOptions): ShipfixEnvLoadResult {
  const rootEnvExists = existsSync(options.rootEnvPath);
  const appLocalEnvExists = existsSync(options.appLocalEnvPath);
  const rootOverride = options.rootOverride ?? false;
  const appLocalOverride = true;
  const rootResult: DotenvConfigOutput = loadEnvFile({
    path: options.rootEnvPath,
    override: rootOverride,
  });
  const appLocalResult: DotenvConfigOutput = loadEnvFile({
    path: options.appLocalEnvPath,
    override: appLocalOverride,
  });

  const sources: string[] = [];
  if (rootEnvExists) sources.push("repo-root/.env");
  if (appLocalEnvExists) sources.push("app/.env.local");
  if (sources.length === 0) sources.push("process environment only");

  return {
    rootEnvPath: options.rootEnvPath,
    appLocalEnvPath: options.appLocalEnvPath,
    rootEnvExists,
    appLocalEnvExists,
    rootEnvLoaded: !rootResult.error,
    appLocalEnvLoaded: !appLocalResult.error,
    rootEnvOverride: rootOverride,
    appLocalEnvOverride: appLocalOverride,
    envSourcePath: sources.join(" + "),
  };
}

function normalizePgUrl(connectionString: string): URL {
  return new URL(connectionString.replace(/^postgres(ql)?:/i, "http:"));
}

function redactHost(hostname: string): string {
  if (!hostname) return "(unknown)";
  if (hostname === "localhost" || hostname === "127.0.0.1") return hostname;
  const parts = hostname.split(".");
  const head = parts[0] ?? hostname;
  const tail = parts.length > 1 ? `.${parts.slice(1).join(".")}` : "";
  if (head.length <= 4) return `${head}***${tail}`;
  return `${head.slice(0, 4)}***${tail}`;
}

/** Safe DB fingerprint for logs and admin diagnostics — never includes credentials. */
export function databaseFingerprint(connectionString?: string): DatabaseFingerprint {
  if (!connectionString?.trim()) {
    return {
      databaseUrlPresent: false,
      hostHash: null,
      hostRedacted: null,
      databaseName: null,
    };
  }
  try {
    const url = normalizePgUrl(connectionString.trim());
    const host = url.hostname;
    const hostHash = createHash("sha256").update(host).digest("hex").slice(0, 12);
    const databaseName = decodeURIComponent(url.pathname.replace(/^\//, "")) || null;
    return {
      databaseUrlPresent: true,
      hostHash,
      hostRedacted: redactHost(host),
      databaseName,
    };
  } catch {
    return {
      databaseUrlPresent: true,
      hostHash: "unparseable",
      hostRedacted: null,
      databaseName: null,
    };
  }
}

/**
 * Local dev isolation: Temporal task queues are shared by all workers connected
 * to a Temporal server. If two local ShipFix checkouts/workers point at
 * different databases but poll the same queue, a run can be picked up by the
 * wrong worker and stall after analysis. Production can still set any explicit
 * queue; dev only rewrites the generic default queue into a DB-scoped queue.
 */
export function effectiveTemporalTaskQueue(
  configuredQueue: string | undefined,
  databaseUrl: string | undefined,
  nodeEnv = process.env.NODE_ENV,
): string {
  const trimmed = configuredQueue?.trim();
  if (nodeEnv === "production") return trimmed || "shipfix";
  if (trimmed && trimmed !== "shipfix") return trimmed;

  const fp = databaseFingerprint(databaseUrl);
  if (!fp.databaseUrlPresent || !fp.hostHash) return "shipfix-local";
  const dbName = fp.databaseName ?? "unknown";
  const queueHash = createHash("sha256").update(`${fp.hostHash}:${dbName}`).digest("hex").slice(0, 12);
  return `shipfix-${queueHash}`;
}

export function logDatabaseFingerprint(
  serviceName: string,
  connectionString: string | undefined,
  envLoad: ShipfixEnvLoadResult,
): void {
  const fp = databaseFingerprint(connectionString);
  // eslint-disable-next-line no-console
  console.log(`[${serviceName}] database fingerprint`, {
    databaseUrlPresent: fp.databaseUrlPresent,
    hostHash: fp.hostHash,
    hostRedacted: fp.hostRedacted,
    databaseName: fp.databaseName,
    envSourcePath: envLoad.envSourcePath,
    rootEnvPath: envLoad.rootEnvPath,
    rootEnvExists: envLoad.rootEnvExists,
    rootEnvOverride: envLoad.rootEnvOverride,
    appLocalEnvPath: envLoad.appLocalEnvPath,
    appLocalEnvExists: envLoad.appLocalEnvExists,
    appLocalEnvOverride: envLoad.appLocalEnvOverride,
  });
}
