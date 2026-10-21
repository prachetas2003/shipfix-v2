import type { DataNeed, EnvRef, EscapePlan, SupabaseUsage } from "@shipfix/contracts";
import type { RepoSource } from "./source";
import { allDeps, safeParseJson, type PackageJson } from "./util";

type EscapeSource = EscapePlan["source"];

const PLATFORM: Record<EscapeSource, string> = {
  lovable: "Lovable Cloud",
  bolt: "Bolt",
  replit: "Replit",
};

function readmeHit(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}

async function packageText(source: RepoSource, files: ReadonlySet<string>): Promise<string> {
  const paths = [...files].filter((file) => file === "package.json" || file.endsWith("/package.json")).slice(0, 40);
  const chunks: string[] = [];
  for (const path of paths) {
    const pkg = safeParseJson<PackageJson>(await source.readFile(path));
    if (!pkg) continue;
    chunks.push(Object.keys(allDeps(pkg)).join("\n"));
  }
  return chunks.join("\n");
}

/**
 * Lovable, Bolt, or Replit, from files in this commit.
 * Lovable wins when more than one mark is present, then Replit, then Bolt.
 */
export async function detectEscapeSource(source: RepoSource, files: ReadonlySet<string>): Promise<EscapeSource | null> {
  const deps = await packageText(source, files);
  const readme = (await source.readFile("README.md")) ?? "";
  const lovable = deps.includes("lovable-tagger") || deps.includes("@lovable.dev/") || readmeHit(readme, "Welcome to your Lovable project") || readmeHit(readme, "lovable.dev");
  const replit = files.has(".replit") || files.has("replit.nix");
  const bolt = files.has(".bolt/config.json") || files.has("bolt.json") || readmeHit(readme, "bolt.new");
  if (lovable) return "lovable";
  if (replit) return "replit";
  if (bolt) return "bolt";
  return null;
}

function hasSchema(dataNeeds: DataNeed[], supabase: SupabaseUsage | undefined): boolean {
  if ((supabase?.migrations?.length ?? 0) > 0) return true;
  return dataNeeds.some((need) => need.migrationTool !== "none");
}

function hasDatabase(dataNeeds: DataNeed[], supabase: SupabaseUsage | undefined): boolean {
  if (supabase) return true;
  return dataNeeds.some((need) => need.kind === "postgres" || need.kind === "mysql" || need.kind === "sqlite_local");
}

function hasAuth(envRefs: EnvRef[], supabase: SupabaseUsage | undefined): boolean {
  if (supabase) return true;
  return envRefs.some((ref) => /AUTH|CLERK|NEXTAUTH/i.test(ref.name));
}

function hasStorage(files: ReadonlySet<string>, dataNeeds: DataNeed[]): boolean {
  if (dataNeeds.some((need) => need.kind === "object_storage")) return true;
  return [...files].some((file) => /(^|\/)storage\//i.test(file));
}

/** What moves into the user's accounts, and what stays on the old host. */
export function buildEscapePlan(
  source: EscapeSource,
  opts: { schema: boolean; database: boolean; auth: boolean; storage: boolean },
): EscapePlan {
  const platform = PLATFORM[source];
  const moves: EscapePlan["moves"] = [
    {
      id: "code",
      title: "Code",
      automatic: true,
      detail: "ShipFix deploys this repo into the Vercel, Render, Neon, and Supabase accounts you connect.",
    },
  ];
  if (opts.schema) {
    moves.push({
      id: "schema",
      title: "Schema",
      automatic: true,
      detail: "The migrations already in the repo are applied to the database you connect.",
    });
  }
  moves.push({
    id: "secrets",
    title: "Secrets",
    automatic: false,
    detail: `ShipFix asks you for each setting the code names. It cannot read the secret store on ${platform}.`,
  });
  if (opts.database) {
    moves.push({
      id: "rows",
      title: "Table rows",
      automatic: false,
      detail: `Live rows stay on ${platform}. Export the database there, then import it into the database you connect. ShipFix does not connect to ${platform} to copy them.`,
    });
  }
  if (opts.auth) {
    moves.push({
      id: "auth",
      title: "Auth users",
      automatic: false,
      detail: `Accounts stay on ${platform}. For Supabase, a database export that includes auth.users is how those accounts move. ShipFix does not copy them by itself.`,
    });
  }
  if (opts.storage) {
    moves.push({
      id: "storage",
      title: "Storage files",
      automatic: false,
      detail: `Uploaded files stay on ${platform}. Download them there and put them in the storage account you connect.`,
    });
  }
  return { source, platform, moves };
}

export async function detectEscape(
  source: RepoSource,
  files: ReadonlySet<string>,
  dataNeeds: DataNeed[],
  envRefs: EnvRef[],
  supabase: SupabaseUsage | undefined,
): Promise<EscapePlan | undefined> {
  const platform = await detectEscapeSource(source, files);
  if (!platform) return undefined;
  return buildEscapePlan(platform, {
    schema: hasSchema(dataNeeds, supabase),
    database: hasDatabase(dataNeeds, supabase),
    auth: hasAuth(envRefs, supabase),
    storage: hasStorage(files, dataNeeds),
  });
}
