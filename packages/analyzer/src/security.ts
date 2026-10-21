import type { SecurityFinding, SecurityReport, ServiceSignal } from "@shipfix/contracts";
import type { RepoSource } from "./source";
import { listSupabaseMigrations, stripSqlNoise, tablesWithoutRls } from "./supabaseMigrations";
import { MAX_SCAN_BYTES, safeParseJson, type PackageJson } from "./util";

const MAX_FILES = 250;
const MAX_FINDINGS = 12;

const SKIP_FILE_RE =
  /(^|\/)(node_modules|dist|build|coverage|\.next|vendor)\/|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|uv\.lock$|\.min\.js$/;

const TEXT_RE = /\.(tsx?|jsx?|mjs|cjs|py|env|json|toml|yml|yaml|sql|html|vue|svelte)$|(^|\/)\.env(\.|$)/;

/** Real credentials. Placeholders and short samples do not match. */
const SECRET_RES: Array<{ code: string; label: string; re: RegExp }> = [
  { code: "stripe_secret", label: "Stripe secret key", re: /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { code: "github_token", label: "GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { code: "aws_key", label: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "private_key", label: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: "slack_token", label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { code: "supabase_secret", label: "Supabase secret key", re: /\bsb_secret_[A-Za-z0-9]{10,}/ },
];

const PUBLIC_PREFIX_RE = /\b(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)[A-Z0-9_]*\b/;

const KNOWN_BAD: Record<string, { versions: string[]; detail: string }> = {
  "event-stream": { versions: ["3.3.6"], detail: "event-stream 3.3.6 shipped a malicious dependency." },
  "ua-parser-js": { versions: ["0.7.29", "0.8.0", "1.0.0"], detail: "These ua-parser-js versions were hijacked." },
  "node-ipc": { versions: ["9.1.1", "9.1.2", "9.2.2", "10.1.0"], detail: "These node-ipc versions contained destructive code." },
  colors: { versions: ["1.4.1", "1.4.2"], detail: "These colors releases intentionally broke installs." },
  faker: { versions: ["6.6.6"], detail: "faker 6.6.6 was a sabotaged release." },
};

const HEADER_MARK_RE = /x-frame-options|content-security-policy|strict-transport-security/i;
const HEADER_FILES = ["vercel.json", "next.config.js", "next.config.mjs", "next.config.ts", "middleware.ts", "middleware.js"];

const POLICY_TRUE_RE = /\bcreate\s+policy\b[\s\S]{0,500}?\b(using|with\s+check)\s*\(\s*true\s*\)/gi;

export function readinessScore(findings: Array<{ severity: SecurityFinding["severity"] }>): number {
  let score = 100;
  for (const finding of findings) {
    score -= finding.severity === "high" ? 25 : finding.severity === "medium" ? 10 : 5;
  }
  return Math.max(0, Math.min(100, score));
}

function serviceRoleJwt(text: string): boolean {
  const re = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
  for (const match of text.matchAll(re)) {
    try {
      const payload = JSON.parse(Buffer.from(match[0].split(".")[1] ?? "", "base64url").toString("utf8")) as {
        role?: unknown;
      };
      if (payload.role === "service_role") return true;
    } catch {
      /* not a jwt */
    }
  }
  return false;
}

function frontendRoots(services: ServiceSignal[]): string[] {
  return services
    .filter((s) => s.role === "frontend" || s.role === "fullstack" || /vite|next|react/i.test(s.framework))
    .map((s) => s.rootDir);
}

function inFrontend(file: string, roots: string[]): boolean {
  if (roots.length === 0) return false;
  return roots.some((root) => root === "" || file === root || file.startsWith(`${root}/`));
}

function push(findings: SecurityFinding[], finding: SecurityFinding): void {
  if (findings.length >= MAX_FINDINGS) return;
  if (findings.some((f) => f.code === finding.code && f.file === finding.file)) return;
  findings.push(finding);
}

function exactVersion(spec: string): string {
  return spec.trim().replace(/^[\^~>=<]*/, "");
}

async function knownBadDeps(source: RepoSource, files: string[], findings: SecurityFinding[]): Promise<void> {
  for (const file of files) {
    if (!file.endsWith("package.json")) continue;
    const pkg = safeParseJson<PackageJson>(await source.readFile(file));
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    for (const [name, spec] of Object.entries(deps)) {
      const bad = KNOWN_BAD[name];
      if (!bad || typeof spec !== "string") continue;
      if (!bad.versions.includes(exactVersion(spec))) continue;
      push(findings, {
        code: "known_bad_dependency",
        severity: "high",
        title: `Known-bad dependency ${name}`,
        detail: `${bad.detail} Remove or upgrade it before shipping.`,
        file,
        fixable: false,
      });
    }
  }
}

async function headerFinding(source: RepoSource, files: ReadonlySet<string>, services: ServiceSignal[], findings: SecurityFinding[]): Promise<void> {
  if (frontendRoots(services).length === 0) return;
  for (const name of HEADER_FILES) {
    if (!files.has(name)) continue;
    const text = (await source.readFile(name)) ?? "";
    if (HEADER_MARK_RE.test(text)) return;
  }
  push(findings, {
    code: "missing_headers",
    severity: "medium",
    title: "Security headers are not set",
    detail:
      "The frontend does not send X-Frame-Options, a content security policy, or strict transport security. ShipFix can add the basic set in vercel.json.",
    file: "vercel.json",
    fixable: true,
  });
}

/**
 * Static launch-readiness scan. Findings name the file and the kind of problem.
 * They never include the secret itself. A live database is not contacted.
 */
export async function scanSecurity(
  source: RepoSource,
  files: ReadonlySet<string>,
  services: ServiceSignal[],
): Promise<SecurityReport> {
  const findings: SecurityFinding[] = [];
  const fronts = frontendRoots(services);
  const readable = [...files].filter((f) => !SKIP_FILE_RE.test(f) && TEXT_RE.test(f)).slice(0, MAX_FILES);

  for (const file of readable) {
    const text = ((await source.readFile(file)) ?? "").slice(0, MAX_SCAN_BYTES);
    if (!text) continue;
    const onClient = inFrontend(file, fronts);
    const roleJwt = serviceRoleJwt(text);
    if (roleJwt) {
      push(findings, {
        code: onClient ? "client_secret" : "committed_secret",
        severity: "high",
        title: onClient ? "Service-role key is in client code" : "Service-role key is committed",
        detail: onClient
          ? "A Supabase service-role key is in frontend code, so anyone who loads the app can bypass row security. Rotate the key and keep it on the server."
          : "A Supabase service-role key is committed. Rotate it and load it from the host's environment.",
        file,
        fixable: false,
      });
    }
    for (const secret of SECRET_RES) {
      if (!secret.re.test(text)) continue;
      const publicLine = text.split(/\r?\n/).some((line) => secret.re.test(line) && PUBLIC_PREFIX_RE.test(line));
      const client = onClient && publicLine;
      push(findings, {
        code: client ? "client_secret" : "committed_secret",
        severity: "high",
        title: client ? `${secret.label} would ship in the browser` : `${secret.label} is committed`,
        detail: client
          ? `A ${secret.label} is assigned to a public env var. Browsers can read it. Rotate the key and move it server-side.`
          : `A ${secret.label} is in the repo. Rotate it, then remove it from the file. This scan covers the deployed commit, not older history.`,
        file,
        fixable: false,
      });
    }
  }

  const migrations = listSupabaseMigrations(files);
  if (migrations.length > 0) {
    for (const table of await tablesWithoutRls(source, migrations)) {
      push(findings, {
        code: "rls_disabled",
        severity: "high",
        title: `Table ${table} has no row security`,
        detail: `Migrations create public.${table} without enabling row level security. The anon key can read and write it. ShipFix did not connect to the live database.`,
        file: "supabase/migrations",
        fixable: false,
      });
    }
    for (const migration of migrations) {
      const sql = stripSqlNoise(((await source.readFile(migration.file)) ?? "").slice(0, MAX_SCAN_BYTES));
      if (!POLICY_TRUE_RE.test(sql)) continue;
      POLICY_TRUE_RE.lastIndex = 0;
      push(findings, {
        code: "rls_policy_true",
        severity: "high",
        title: "A row-security policy allows everyone",
        detail: `${migration.file} creates a policy with USING (true) or WITH CHECK (true). That leaves the table open to the anon key. ShipFix did not connect to the live database.`,
        file: migration.file,
        fixable: false,
      });
    }
  }

  await knownBadDeps(source, [...files], findings);
  await headerFinding(source, files, services, findings);

  const ranked = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity)).slice(0, MAX_FINDINGS);
  return { score: readinessScore(ranked), findings: ranked, historyScanned: false };
}

function severityRank(severity: SecurityFinding["severity"]): number {
  if (severity === "high") return 0;
  if (severity === "medium") return 1;
  return 2;
}
