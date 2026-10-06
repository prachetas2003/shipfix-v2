import type { RepoSource } from "./source";
import type { EnvRef, HardcodedUrl } from "@shipfix/contracts";
import type { WorkspaceLibrary } from "./services";
import { MAX_SCAN_BYTES, isCodeFile, nearestRoot } from "./util";

/**
 * Vite/runtime builtins that look like env refs but carry no deployment signal.
 * Excluding them keeps RepoContext.envRefs to vars a user must actually supply.
 */
const ENV_NOISE = new Set([
  "NODE_ENV",
  "MODE",
  "DEV",
  "PROD",
  "SSR",
  "BASE_URL",
  // OS / shell / CI plumbing — set by the runtime, never by the user.
  "CI",
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "TERM",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "HOSTNAME",
  "GITHUB_ACTIONS",
  // Framework internals and builder dev toggles.
  "NEXT_RUNTIME",
  "NEXT_PHASE",
  "DISABLE_HMR",
]);

/** Hosting-platform variables (the old platform sets them; the new one never needs them from the user). */
const PLATFORM_PREFIX_RE = /^(REPL_|REPLIT_|VERCEL_|RENDER_|NETLIFY_|RAILWAY_|FLY_|npm_)/;
const PLATFORM_NAMES = new Set(["VERCEL", "VERCEL_ENV", "VERCEL_URL", "RENDER", "NETLIFY", "REPLIT", "REPL_ID"]);

/**
 * Code that never runs in the deployed app: tests, e2e, benchmarks, fixtures,
 * stories, and repo scripts. Env refs and localhost URLs there are not
 * deployment requirements.
 */
const NON_RUNTIME_DIR_RE =
  /(^|\/)(__tests__|__mocks__|tests?|e2e|specs?|cypress|playwright|benchmarks?|bench|fixtures|stories|\.storybook|scripts)\//i;
const NON_RUNTIME_FILE_RE =
  /(\.(test|spec|stories|bench|e2e)\.[cm]?[jt]sx?$)|((^|\/)(playwright|vitest|jest|cypress)\.config\.[cm]?[jt]s$)/i;

/** Dev-server/bundler config: localhost there is the dev proxy, not a runtime call. */
const DEV_CONFIG_FILE_RE = /(^|\/)(vite|next|nuxt|astro|svelte|webpack|rollup|tsup)\.config\.[cm]?[jt]s$/i;

const ENV_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
];

/** `os.environ["X"]` always raises when unset; `.get`/`getenv` fall back when given a default. */
const PY_ENV_INDEX_RE = /os\.environ\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g;
const PY_ENV_GET_RE = /(?:os\.environ\.get|os\.getenv)\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*(,)?/g;
const PY_OR_FALLBACK_RE = /^\s*\)\s*or\b/;
const NON_RUNTIME_PY_RE = /(^|\/)(test_[^/]*|[^/]*_test|conftest|setup)\.py$/;

/** Client constructors that read fixed env names without naming them in code. */
const IMPLICIT_ENV: ReadonlyArray<[RegExp, readonly string[]]> = [
  [/\bRedis\.fromEnv\s*\(/, ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]],
  [/import\s*\{[^}]*\bkv\b[^}]*\}\s*from\s*['"]@vercel\/kv['"]/, ["KV_REST_API_URL", "KV_REST_API_TOKEN"]],
];

/** `process.env.X ?? "…"` / `|| "…"` — the code supplies its own default. */
const FALLBACK_RE = /^\s*(\?\?|\|\|)/;

// http(s)/ws(s)://localhost | 127.0.0.1 | 0.0.0.0 (+ optional :port and path)
const LOCALHOST_RE =
  /\b(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s'"`)\]}>]*/g;

export function isNonRuntimeFile(file: string): boolean {
  return NON_RUNTIME_DIR_RE.test(file) || NON_RUNTIME_FILE_RE.test(file);
}

const CLIENT_PREFIX_RE = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_)/;

function isNoiseEnv(name: string): boolean {
  const bare = name.replace(CLIENT_PREFIX_RE, "");
  return ENV_NOISE.has(name) || PLATFORM_NAMES.has(bare) || PLATFORM_PREFIX_RE.test(bare);
}

/**
 * Scan code files for environment-variable references (names only — never
 * values) and hardcoded localhost URLs. Each finding is attributed to the
 * nearest service root so the planner/UI can group them; code in an internal
 * library is attributed to every service that imports it.
 *
 * A ref is `required` unless every occurrence supplies a fallback — a user is
 * only asked for values the app cannot run without.
 */
export async function detectEnvAndUrls(
  source: RepoSource,
  files: ReadonlySet<string>,
  serviceRoots: string[],
  libraries: readonly WorkspaceLibrary[] = [],
  pythonRoots: ReadonlySet<string> = new Set(),
): Promise<{ envRefs: EnvRef[]; hardcodedUrls: HardcodedUrl[] }> {
  const envByKey = new Map<string, EnvRef>(); // `${service}\u0000${name}`
  const hardcodedUrls: HardcodedUrl[] = [];
  const libraryRoots = libraries.map((l) => l.rootDir);

  function ownersOf(file: string): string[] {
    const service = nearestRoot(file, serviceRoots);
    const libRoot = nearestRoot(file, libraryRoots);
    if (!libraryRoots.includes(libRoot) || service.length >= libRoot.length) return [service];
    const dependents = libraries.find((l) => l.rootDir === libRoot)?.dependents ?? [];
    return dependents.length ? dependents : [service];
  }

  for (const file of files) {
    if (file.endsWith(".py")) {
      const service = nearestRoot(file, serviceRoots);
      if (!pythonRoots.has(service)) continue;
      if (isNonRuntimeFile(file) || NON_RUNTIME_PY_RE.test(file) || /(^|\/)\.?venv\//.test(file)) continue;
      const text = await source.readFile(file);
      if (text == null) continue;
      const slice = text.length > MAX_SCAN_BYTES ? text.slice(0, MAX_SCAN_BYTES) : text;
      const add = (name: string, required: boolean): void => {
        if (isNoiseEnv(name)) return;
        const key = `${service}\u0000${name}`;
        const existing = envByKey.get(key);
        if (existing) existing.required ||= required;
        else envByKey.set(key, { name, service, required });
      };
      for (const m of slice.matchAll(PY_ENV_INDEX_RE)) add(m[1], true);
      for (const m of slice.matchAll(PY_ENV_GET_RE)) {
        const after = slice.slice(m.index! + m[0].length, m.index! + m[0].length + 12);
        add(m[1], !m[2] && !PY_OR_FALLBACK_RE.test(after));
      }
      continue;
    }
    if (!isCodeFile(file) || isNonRuntimeFile(file)) continue;
    const text = await source.readFile(file);
    if (text == null) continue;
    const slice = text.length > MAX_SCAN_BYTES ? text.slice(0, MAX_SCAN_BYTES) : text;
    const owners = ownersOf(file);
    const addRef = (name: string, required: boolean): void => {
      for (const service of owners) {
        const key = `${service}\u0000${name}`;
        const existing = envByKey.get(key);
        if (existing) existing.required ||= required;
        else envByKey.set(key, { name, service, required });
      }
    };

    for (const pattern of ENV_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of slice.matchAll(pattern)) {
        const name = match[1];
        if (isNoiseEnv(name)) continue;
        const after = slice.slice(match.index! + match[0].length, match.index! + match[0].length + 8);
        addRef(name, !FALLBACK_RE.test(after));
      }
    }
    for (const [pattern, names] of IMPLICIT_ENV) {
      if (pattern.test(slice)) for (const name of names) addRef(name, true);
    }

    if (DEV_CONFIG_FILE_RE.test(file)) continue;
    LOCALHOST_RE.lastIndex = 0;
    for (const match of slice.matchAll(LOCALHOST_RE)) {
      for (const service of owners) hardcodedUrls.push({ value: match[0], file, service });
    }
  }

  const envRefs = [...envByKey.values()];
  envRefs.sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
  hardcodedUrls.sort((a, b) => a.file.localeCompare(b.file) || a.value.localeCompare(b.value));

  return { envRefs, hardcodedUrls };
}
