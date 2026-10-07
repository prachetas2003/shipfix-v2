/**
 * Turns raw provider build/runtime logs into a named failure the autofix loop
 * and the UI can act on. Pure text matching: deterministic and testable.
 */

export type LogFailureKind =
  | "missing_module"
  | "import_path_case"
  | "missing_script"
  | "lockfile_mismatch"
  | "dependency_conflict"
  | "node_version"
  | "typescript_error"
  | "syntax_error"
  | "out_of_memory"
  | "no_open_port"
  | "missing_env"
  | "db_unreachable"
  | "localhost_url"
  | "prisma_client"
  | "python_dependency"
  | "python_import"
  | "command_not_found"
  | "unknown";

export type FailingPhase = "install" | "build" | "start";

/** Who can fix it: ShipFix by rule, ShipFix with the LLM loop, or only the user. */
export type FixOwner = "deterministic" | "llm" | "user";

export interface LogDiagnosis {
  kind: LogFailureKind;
  phase: FailingPhase | null;
  title: string;
  /** One plain-English sentence for a non-technical builder. */
  explanation: string;
  /** The specific thing at fault (module name, env var, script), when known. */
  subject: string | null;
  fixOwner: FixOwner;
  /** The log lines that matched, most relevant first (at most 5). */
  evidence: string[];
}

interface Rule {
  kind: LogFailureKind;
  phase: FailingPhase;
  fixOwner: FixOwner;
  re: RegExp;
  title: string;
  explain: (subject: string | null) => string;
}

// Order matters: the first rule whose pattern matches wins, so specific
// causes come before the generic symptoms they also produce.
const RULES: Rule[] = [
  {
    kind: "out_of_memory",
    phase: "build",
    fixOwner: "deterministic",
    re: /JavaScript heap out of memory|FATAL ERROR: Reached heap limit|Ran out of memory|exited with code 137|signal: killed|\bOOMKilled\b/i,
    title: "Ran out of memory",
    explain: () => "The build or server used more memory than the plan allows and was stopped.",
  },
  {
    kind: "lockfile_mismatch",
    phase: "install",
    fixOwner: "deterministic",
    re: /can only install packages when your package\.json and package-lock\.json[^\n]*in sync|ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE_|Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`|lockfile had changes, but lockfile is frozen/i,
    title: "Lockfile out of date",
    explain: () => "The lockfile doesn't match package.json, so the clean install the host runs refuses to continue.",
  },
  {
    kind: "dependency_conflict",
    phase: "install",
    fixOwner: "deterministic",
    re: /ERESOLVE (?:unable to resolve dependency tree|could not resolve)|Conflicting peer dependency/i,
    title: "Conflicting package versions",
    explain: () => "Two packages ask for incompatible versions of the same dependency, so npm stops the install.",
  },
  {
    kind: "node_version",
    phase: "install",
    fixOwner: "deterministic",
    re: /The engine "node" is incompatible|Unsupported engine|requires (?:a )?Node(?:\.js)? (?:version )?[>=^~]*\s*v?(\d+)|You are using Node\.js [\d.]+\. [^\n]*requires Node\.js/i,
    title: "Wrong Node.js version",
    explain: () => "The app or one of its packages needs a different Node.js version than the host used.",
  },
  {
    kind: "missing_script",
    phase: "build",
    fixOwner: "deterministic",
    re: /Missing script: "?([\w:.-]+)"?|ERR_PNPM_NO_SCRIPT[^\n]*?"?([\w:.-]+)"?|error Command "([\w:.-]+)" not found/i,
    title: "Missing package.json script",
    explain: (s) => `The command runs \`${s ?? "a script"}\`, but package.json has no script with that name.`,
  },
  {
    kind: "import_path_case",
    phase: "build",
    fixOwner: "deterministic",
    re: /(?:Can't resolve|Could not resolve|failed to resolve import|Cannot find module) ['"](\.{1,2}\/[^'"]+)['"]/i,
    title: "Import points at a file that isn't there",
    explain: (s) =>
      `The code imports \`${s ?? "a local file"}\`, which doesn't exist on the server. It often works locally because macOS and Windows ignore upper/lower case in file names and Linux doesn't.`,
  },
  {
    kind: "missing_module",
    phase: "build",
    fixOwner: "deterministic",
    re: /Cannot find module ['"]([^'"]+)['"]|Module not found: (?:Error: )?Can't resolve ['"]([^'"]+)['"]|Rollup failed to resolve import ['"]([^'"]+)['"]|Cannot find package ['"]([^'"]+)['"]|ERR_MODULE_NOT_FOUND[^\n]*?['"]([^'"]+)['"]/i,
    title: "A package is missing",
    explain: (s) => `The code uses \`${s ?? "a package"}\`, but it isn't listed in package.json, so the host never installed it.`,
  },
  {
    kind: "prisma_client",
    phase: "build",
    fixOwner: "deterministic",
    re: /@prisma\/client did not initialize yet|Prisma Client could not locate the Query Engine|Run "prisma generate"/i,
    title: "Prisma client was never generated",
    explain: () => "The app uses Prisma, but `prisma generate` didn't run during the build.",
  },
  {
    kind: "typescript_error",
    phase: "build",
    fixOwner: "llm",
    re: /error TS\d{4}:|Type error: /,
    title: "TypeScript errors stop the build",
    explain: () => "The build runs a strict type check and the code has type errors, even though it may run fine in development.",
  },
  {
    kind: "syntax_error",
    phase: "build",
    fixOwner: "llm",
    re: /SyntaxError: |Unexpected token|Expected [^\n]* but found/,
    title: "Code doesn't parse",
    explain: () => "A file has a syntax error, so it can't be compiled or run.",
  },
  {
    kind: "python_dependency",
    phase: "install",
    fixOwner: "deterministic",
    re: /Could not find a version that satisfies the requirement ([\w.\-[\]]+)|No matching distribution found for ([\w.\-[\]]+)|error: subprocess-exited-with-error|ResolutionImpossible/i,
    title: "Python packages failed to install",
    explain: (s) => `pip couldn't install ${s ? `\`${s}\`` : "the requirements"} (a version that doesn't exist, or a package that needs system libraries).`,
  },
  {
    kind: "python_import",
    phase: "start",
    fixOwner: "deterministic",
    re: /ModuleNotFoundError: No module named ['"]([\w.]+)['"]|ImportError: cannot import name/i,
    title: "A Python module is missing",
    explain: (s) => `The app imports \`${s ?? "a module"}\`, which isn't in the requirements or isn't on the import path.`,
  },
  {
    kind: "missing_env",
    phase: "start",
    fixOwner: "user",
    re: /Missing (?:required )?environment variable:? ['"`]?([A-Z][A-Z0-9_]+)|Environment variable not found: ([A-Z][A-Z0-9_]+)|KeyError: ['"]([A-Z][A-Z0-9_]+)['"]|([A-Z][A-Z0-9_]{2,}) is (?:not set|required|missing)|supabaseUrl is required|Invalid environment variables/,
    title: "A required setting is missing",
    explain: (s) => `The app needs ${s ? `\`${s}\`` : "an environment variable"} at startup and it isn't set on the host.`,
  },
  {
    kind: "localhost_url",
    phase: "start",
    fixOwner: "deterministic",
    re: /connect ECONNREFUSED (?:127\.0\.0\.1|::1|localhost):(?!5432|3306|6379|27017)(\d+)/,
    title: "The app calls localhost",
    explain: () => "The app tries to reach a service on localhost, which only exists on the developer's machine.",
  },
  {
    kind: "db_unreachable",
    phase: "start",
    fixOwner: "deterministic",
    re: /ECONNREFUSED (?:127\.0\.0\.1|::1|localhost):(?:5432|3306|6379|27017)|could not connect to server|Can't reach database server|P1001|connection to server at "localhost"/i,
    title: "Can't reach the database",
    explain: () => "The app is pointing at a database on localhost or an address the host can't reach, instead of the provisioned one.",
  },
  {
    kind: "no_open_port",
    phase: "start",
    fixOwner: "deterministic",
    re: /No open (?:HTTP )?ports detected|Port scan timeout reached|failed to bind to \$PORT|EADDRINUSE/i,
    title: "The server isn't listening on the right port",
    explain: () => "The host waits for the app on the port in the PORT variable, but the app listens on a fixed port or never starts a server.",
  },
  {
    kind: "command_not_found",
    phase: "build",
    fixOwner: "deterministic",
    re: /sh: \d+: ([\w.-]+): not found|([\w.-]+): command not found|'([\w.-]+)' is not recognized as an internal or external command/i,
    title: "A command isn't installed",
    explain: (s) => `The build or start command runs \`${s ?? "a tool"}\`, which isn't installed on the host (often a devDependency that was skipped).`,
  },
];

const MAX_EVIDENCE = 5;

/** Classify a log tail. Returns kind "unknown" (never throws) when nothing matches. */
export function diagnoseLogs(text: string): LogDiagnosis {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  for (const rule of RULES) {
    const hits = lines.filter((l) => rule.re.test(l));
    if (hits.length === 0) continue;
    const m = rule.re.exec(hits[0]!);
    const subject = m?.slice(1).find((g) => g !== undefined) ?? null;
    return {
      kind: rule.kind,
      phase: rule.phase,
      title: rule.title,
      explanation: rule.explain(subject),
      subject,
      fixOwner: rule.fixOwner,
      evidence: hits.slice(0, MAX_EVIDENCE),
    };
  }
  const errorLines = lines.filter((l) => /\berror\b|failed|exception|traceback/i.test(l));
  return {
    kind: "unknown",
    phase: null,
    title: "Deploy failed",
    explanation: "The host reported a failure ShipFix doesn't recognize yet.",
    subject: null,
    fixOwner: "llm",
    evidence: errorLines.slice(-MAX_EVIDENCE),
  };
}

/** Remove secret values from provider log text before it is stored or sent anywhere. */
export function scrubLogText(text: string, secretValues: Iterable<string>): string {
  let out = text;
  const values = [...secretValues].filter((v) => v.length >= 8).sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join("[redacted]");
  return out;
}

/** Keep the last `maxLines` lines and at most `maxChars` characters. */
export function tailLines(lines: string[], maxLines = 120, maxChars = 12_000): string {
  const tail = lines.slice(-maxLines).join("\n");
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
}
