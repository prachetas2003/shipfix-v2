import type { RepoSource } from "./source";
import type { EnvRef, HardcodedUrl } from "@shipfix/contracts";
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
]);

const ENV_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
];

// http(s)/ws(s)://localhost | 127.0.0.1 | 0.0.0.0 (+ optional :port and path)
const LOCALHOST_RE =
  /\b(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s'"`)\]}>]*/g;

/**
 * Scan code files for environment-variable references (names only — never
 * values) and hardcoded localhost URLs. Each finding is attributed to the
 * nearest service root so the planner/UI can group them.
 */
export async function detectEnvAndUrls(
  source: RepoSource,
  files: ReadonlySet<string>,
  serviceRoots: string[],
): Promise<{ envRefs: EnvRef[]; hardcodedUrls: HardcodedUrl[] }> {
  const envSeen = new Set<string>(); // `${service}\u0000${name}`
  const envRefs: EnvRef[] = [];
  const hardcodedUrls: HardcodedUrl[] = [];

  for (const file of files) {
    if (!isCodeFile(file)) continue;
    const text = await source.readFile(file);
    if (text == null) continue;
    const slice = text.length > MAX_SCAN_BYTES ? text.slice(0, MAX_SCAN_BYTES) : text;
    const service = nearestRoot(file, serviceRoots);

    for (const pattern of ENV_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of slice.matchAll(pattern)) {
        const name = match[1];
        if (ENV_NOISE.has(name)) continue;
        const key = `${service}\u0000${name}`;
        if (envSeen.has(key)) continue;
        envSeen.add(key);
        envRefs.push({ name, service, required: true });
      }
    }

    LOCALHOST_RE.lastIndex = 0;
    for (const match of slice.matchAll(LOCALHOST_RE)) {
      hardcodedUrls.push({ value: match[0], file, service });
    }
  }

  envRefs.sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
  hardcodedUrls.sort((a, b) => a.file.localeCompare(b.file) || a.value.localeCompare(b.value));

  return { envRefs, hardcodedUrls };
}
