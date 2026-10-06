/**
 * Environment hygiene for processes that execute untrusted repository code.
 *
 * Child processes must never inherit the worker's environment wholesale: it holds
 * SHIPFIX_MASTER_KEY, the control-plane DATABASE_URL, LLM keys, and provider tokens.
 * Only the OS/toolchain variables below are forwarded; everything else must be
 * passed explicitly per exec.
 */

const HOST_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "windir",
  "ComSpec",
  "COMSPEC",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "COREPACK_HOME",
  "PNPM_HOME",
  "NVM_DIR",
  "VOLTA_HOME",
] as const;

/** Worker env keys that must never reach untrusted code, even if passed explicitly by mistake. */
const FORBIDDEN_KEY_PATTERNS: RegExp[] = [
  /^SHIPFIX_/i,
  /^TEMPORAL_/i,
  /^CLERK_/i,
  /^GITHUB_APP_/i,
  /^E2B_/i,
  /_API_KEY$/i,
  /^LLM_/i,
  /^NEON_/i,
  /^UPSTASH_/i,
  /^RENDER_/i,
  /^VERCEL_/i,
];

export function isForbiddenSandboxEnvKey(key: string): boolean {
  return FORBIDDEN_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * Build the env for a child process: allowlisted host toolchain vars plus explicit
 * per-exec vars. Explicit vars matching a control-plane secret pattern are dropped.
 */
export function buildSandboxEnv(
  explicit: Record<string, string> = {},
  host: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of HOST_ENV_ALLOWLIST) {
    const value = host[key];
    if (typeof value === "string") out[key] = value;
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (isForbiddenSandboxEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}
