/**
 * @shipfix/sandbox — the ONLY place untrusted repository code may execute.
 *
 * Hard isolation invariants every implementation MUST uphold:
 *  - Fresh, ephemeral sandbox per run; destroyed after (`dispose`). No reuse.
 *  - NO network route from the sandbox to ShipFix control plane / DB / vault.
 *    Outbound limited to package registries + GitHub via an egress allowlist.
 *  - Non-root; read-only base FS except a scratch workspace; CPU/mem/disk/wall
 *    quotas with a hard kill.
 *  - Secrets are NEVER placed in the sandbox. Builds needing secret env get them
 *    only at the provider deploy step, which runs in the worker — not here.
 *
 * First implementation target: E2B (or Fly Machines / Modal). Later: self-hosted
 * Firecracker. Callers depend only on this interface.
 */

export interface ExecOptions {
  cwd?: string;
  timeoutMs: number;
  /** Non-secret env only (e.g. CI=1). Secrets must never be passed here. */
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CloneSpec {
  repoFullName: string;
  sha: string;
  /** Short-lived, read-only GitHub App installation token scoped to one repo. */
  token: string;
}

export interface Sandbox {
  /** Shallow-clone the repo at a commit into the scratch workspace. */
  clone(spec: CloneSpec): Promise<void>;
  /** Run a command in the sandbox. Untrusted lifecycle scripts run here. */
  exec(command: string, options: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  /** Write a file (for proposing safe config fixes that become a reviewable PR). */
  writeFile(path: string, content: string): Promise<void>;
  /** List paths (pruned) for the analyzer's file-tree build. */
  list(globOrDir?: string): Promise<string[]>;
  /** Tear down the sandbox and release all resources. Always called. */
  dispose(): Promise<void>;
}

export interface SandboxProvider {
  /** Allocate a fresh, isolated sandbox for one run. */
  create(opts: {
    runId: string;
    cpu?: number;
    memoryMb?: number;
    diskMb?: number;
    wallClockMs?: number;
  }): Promise<Sandbox>;
}

/**
 * TODO: implement E2BSandboxProvider in a sibling file:
 *  - create() spins an E2B sandbox with the resource + egress policy above,
 *  - clone() uses the scoped GitHub App token,
 *  - exec() enforces the timeout and captures output,
 *  - dispose() kills the sandbox.
 * Keep this `index.ts` interface-only so the control plane can't accidentally
 * import an execution path.
 */
export function createSandboxProvider(): SandboxProvider {
  throw new Error(
    "SandboxProvider not implemented yet — see TODO in @shipfix/sandbox.",
  );
}
