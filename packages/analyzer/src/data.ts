import type { RepoSource } from "./source";
import type { DataNeed, EnvRef } from "@shipfix/contracts";
import { allDeps, baseOf, safeParseJson, type PackageJson } from "./util";

type Kind = DataNeed["kind"];
type Source = DataNeed["detectedFrom"];
type Migration = DataNeed["migrationTool"];

interface Detection {
  kind: Kind;
  detectedFrom: Source;
  migrationTool: Migration;
  evidence: string[];
}

const SOURCE_RANK: Record<Source, number> = {
  prisma: 3,
  drizzle: 3,
  sequelize: 3,
  dep: 2,
  env_ref: 1,
  code: 0,
};

/** Direct runtime dependency -> data need. */
const DEP_TO_KIND: ReadonlyArray<[dep: string, kind: Kind]> = [
  ["pg", "postgres"],
  ["postgres", "postgres"],
  ["@neondatabase/serverless", "postgres"],
  ["@vercel/postgres", "postgres"],
  ["mysql", "mysql"],
  ["mysql2", "mysql"],
  ["redis", "redis"],
  ["ioredis", "redis"],
  ["@upstash/redis", "redis"],
  ["better-sqlite3", "sqlite_local"],
  ["sqlite3", "sqlite_local"],
  ["@aws-sdk/client-s3", "object_storage"],
  ["aws-sdk", "object_storage"],
  ["minio", "object_storage"],
];

/** Env var name (substring/exact) -> data need. */
function kindFromEnvName(name: string): Kind | null {
  if (/^(DATABASE_URL|POSTGRES(QL)?_URL|PG(HOST|DATABASE|USER)?)$/.test(name)) {
    return "postgres";
  }
  if (/^(MYSQL_URL|MYSQL_HOST)$/.test(name)) return "mysql";
  if (/(REDIS_URL|UPSTASH_REDIS)/.test(name)) return "redis";
  return null;
}

function prismaProviderToKind(provider: string): Kind {
  switch (provider) {
    case "mysql":
      return "mysql";
    case "sqlite":
      return "sqlite_local";
    default:
      return "postgres"; // postgresql, cockroachdb, etc.
  }
}

function dialectToKind(dialect: string): Kind {
  if (dialect.startsWith("mysql")) return "mysql";
  if (dialect.startsWith("sqlite")) return "sqlite_local";
  return "postgres";
}

/**
 * Detect data/infrastructure needs (Postgres/MySQL/Redis/object storage/local
 * SQLite) from ORMs, dependencies, config files and env references. Findings
 * are merged per kind, keeping the most specific source and accumulating
 * evidence.
 */
export async function detectDataNeeds(
  source: RepoSource,
  files: ReadonlySet<string>,
  envRefs: EnvRef[],
): Promise<DataNeed[]> {
  const fileList = [...files];
  const detections: Detection[] = [];

  // Merge all declared dependencies across the repo's package.json files.
  const deps: Record<string, string> = {};
  for (const f of fileList.filter((p) => baseOf(p) === "package.json")) {
    const pkg = safeParseJson<PackageJson>(await source.readFile(f));
    if (pkg) Object.assign(deps, allDeps(pkg));
  }
  const has = (name: string): boolean => name in deps;

  // ── Prisma ─────────────────────────────────────────────────────────────
  const prismaSchema = fileList.find((f) => baseOf(f) === "schema.prisma");
  if (has("@prisma/client") || has("prisma") || prismaSchema) {
    const evidence: string[] = [];
    if (prismaSchema) evidence.push(prismaSchema);
    if (has("@prisma/client")) evidence.push('dependency "@prisma/client"');
    let kind: Kind = "postgres";
    if (prismaSchema) {
      const schemaText = (await source.readFile(prismaSchema)) ?? "";
      const m = schemaText.match(
        /datasource\s+\w+\s*\{[\s\S]*?provider\s*=\s*"(\w+)"/,
      );
      if (m) kind = prismaProviderToKind(m[1]);
    }
    detections.push({ kind, detectedFrom: "prisma", migrationTool: "prisma", evidence });
  }

  // ── Drizzle ────────────────────────────────────────────────────────────
  if (has("drizzle-orm")) {
    const evidence: string[] = ['dependency "drizzle-orm"'];
    let kind: Kind = "postgres";
    const config = fileList.find((f) => /(^|\/)drizzle\.config\.(ts|js|mjs|cjs)$/.test(f));
    if (config) {
      evidence.push(config);
      const cfg = (await source.readFile(config)) ?? "";
      const m = cfg.match(/dialect\s*:\s*['"]([\w-]+)['"]/);
      if (m) kind = dialectToKind(m[1]);
      else if (has("mysql2")) kind = "mysql";
      else if (has("better-sqlite3") || has("sqlite3")) kind = "sqlite_local";
    } else if (has("mysql2")) kind = "mysql";
    detections.push({ kind, detectedFrom: "drizzle", migrationTool: "drizzle", evidence });
  }

  // ── Sequelize ──────────────────────────────────────────────────────────
  if (has("sequelize")) {
    let kind: Kind = "postgres";
    if (has("mysql2") || has("mysql")) kind = "mysql";
    else if (has("sqlite3")) kind = "sqlite_local";
    detections.push({
      kind,
      detectedFrom: "sequelize",
      migrationTool: "none",
      evidence: ['dependency "sequelize"'],
    });
  }

  // ── Direct dependencies ──────────────────────────────────────────────────
  for (const [dep, kind] of DEP_TO_KIND) {
    if (has(dep)) {
      detections.push({
        kind,
        detectedFrom: "dep",
        migrationTool: "none",
        evidence: [`dependency "${dep}"`],
      });
    }
  }

  // ── Env references ────────────────────────────────────────────────────────
  for (const ref of envRefs) {
    const kind = kindFromEnvName(ref.name);
    if (kind) {
      detections.push({
        kind,
        detectedFrom: "env_ref",
        migrationTool: "none",
        evidence: [`env var "${ref.name}"`],
      });
    }
  }

  // Merge per kind: keep highest-ranked source, accumulate evidence.
  const byKind = new Map<Kind, Detection>();
  for (const det of detections) {
    const existing = byKind.get(det.kind);
    if (!existing) {
      byKind.set(det.kind, { ...det, evidence: [...det.evidence] });
      continue;
    }
    for (const e of det.evidence) {
      if (!existing.evidence.includes(e)) existing.evidence.push(e);
    }
    if (SOURCE_RANK[det.detectedFrom] > SOURCE_RANK[existing.detectedFrom]) {
      existing.detectedFrom = det.detectedFrom;
      existing.migrationTool = det.migrationTool;
    }
  }

  return [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}
