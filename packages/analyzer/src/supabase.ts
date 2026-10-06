import type { EnvRef, PublicEnvValue, SupabaseUsage } from "@shipfix/contracts";
import type { RepoSource } from "./source";
import { allDeps, baseOf, joinRoot, safeParseJson, type PackageJson } from "./util";

const PROJECT_REF_RE = /^[a-z]{20}$/;
const SUPABASE_HOST_RE = /https:\/\/([a-z]{20})\.supabase\.co\b/;
const SUPABASE_DEPS = ["@supabase/supabase-js", "@supabase/ssr", "@supabase/auth-helpers-nextjs", "@supabase/auth-helpers-react"];
const MAX_CLIENT_FILES = 20;

function refFromUrl(value: string): string | null {
  return value.match(SUPABASE_HOST_RE)?.[1] ?? null;
}

/**
 * Does the app use an existing Supabase project, and which one? The ref comes
 * from `supabase/config.toml` (Lovable writes the real ref there), committed
 * public env, or a hardcoded `<ref>.supabase.co` URL in client code.
 */
export async function detectSupabase(
  source: RepoSource,
  files: ReadonlySet<string>,
  serviceRoots: string[],
  envRefs: EnvRef[],
  publicEnv: PublicEnvValue[],
): Promise<SupabaseUsage | undefined> {
  const evidence: string[] = [];
  let projectRef: string | null = null;
  const found = (ref: string | null, why: string): void => {
    if (ref && !projectRef) {
      projectRef = ref;
      evidence.push(why);
    }
  };

  const configPath = "supabase/config.toml";
  if (files.has(configPath)) {
    evidence.push(configPath);
    const toml = (await source.readFile(configPath)) ?? "";
    const id = toml.match(/^\s*project_id\s*=\s*["']([^"']+)["']/m)?.[1] ?? "";
    found(PROJECT_REF_RE.test(id) ? id : null, `${configPath}: project_id`);
  }

  for (const root of new Set(["", ...serviceRoots])) {
    const pkg = safeParseJson<PackageJson>(await source.readFile(joinRoot(root, "package.json")));
    const dep = pkg ? SUPABASE_DEPS.find((d) => d in allDeps(pkg)) : undefined;
    if (dep) evidence.push(`${joinRoot(root, "package.json")}: dependency "${dep}"`);
  }
  const supabaseRefs = envRefs.filter((r) => r.name.includes("SUPABASE_"));
  if (supabaseRefs.length) evidence.push(`env var "${supabaseRefs[0].name}"`);
  if (evidence.length === 0) return undefined;

  for (const v of publicEnv) {
    if (v.name.endsWith("SUPABASE_PROJECT_ID") && PROJECT_REF_RE.test(v.value)) found(v.value, `${v.file}: ${v.name}`);
    if (v.name.endsWith("SUPABASE_URL")) found(refFromUrl(v.value), `${v.file}: ${v.name}`);
  }

  if (!projectRef) {
    const clientFiles = [...files]
      .filter((f) => /supabase/i.test(f) && /\.(ts|tsx|js|jsx|mjs)$/.test(baseOf(f)) && !f.startsWith("supabase/"))
      .slice(0, MAX_CLIENT_FILES);
    for (const f of clientFiles) {
      found(refFromUrl((await source.readFile(f)) ?? ""), `${f}: Supabase URL`);
      if (projectRef) break;
    }
  }

  return { projectRef, evidence };
}
