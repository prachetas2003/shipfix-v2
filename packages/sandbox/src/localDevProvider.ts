/**
 * ⚠️  DEV ONLY — NOT PRODUCTION SAFE. ⚠️
 *
 * `LocalSandboxProvider` runs the "sandbox" directly on the host: it `git clone`s
 * the repo into an OS temp dir and reads/execs there. It provides NONE of the
 * isolation guarantees the {@link SandboxProvider} contract demands — no network
 * egress allowlist, no FS jail, no resource quotas, no non-root. It exists only
 * so the analyze_only slice can run end-to-end before the real E2B sandbox lands.
 *
 * Do NOT import this from the control plane. It must only ever be constructed by
 * worker activities, and only in development. The production path stays
 * `createSandboxProvider()` in ./index (which throws until E2B is implemented).
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CloneSpec, ExecOptions, ExecResult, Sandbox, SandboxProvider } from "./index";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".vercel",
  ".netlify",
  "coverage",
  ".idea",
  ".vscode",
  "vendor",
  "__pycache__",
]);

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Force git to be strictly non-interactive so a private/missing repo errors out
 * immediately instead of blocking on a username/password or credential-manager
 * prompt (which would otherwise hang the activity).
 */
const GIT_NONINTERACTIVE: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
};

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string>; shell?: boolean },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: opts.shell ?? false,
      env: { ...process.env, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

class LocalDevSandbox implements Sandbox {
  constructor(private readonly workdir: string) {}

  private resolveInside(relPath: string): string {
    const abs = path.resolve(this.workdir, relPath);
    if (abs !== this.workdir && !abs.startsWith(this.workdir + path.sep)) {
      throw new Error(`Path escapes sandbox workspace: ${relPath}`);
    }
    return abs;
  }

  async clone(spec: CloneSpec): Promise<void> {
    const auth = spec.token ? `x-access-token:${spec.token}@` : "";
    const url = `https://${auth}github.com/${spec.repoFullName}.git`;

    const cloned = await runProcess(
      "git",
      // `-c credential.helper=` + GIT_TERMINAL_PROMPT=0 force git to FAIL FAST on
      // a private/nonexistent repo instead of hanging on a credential prompt.
      ["-c", "credential.helper=", "clone", "--depth", "1", url, "."],
      { cwd: this.workdir, timeoutMs: 120_000, env: GIT_NONINTERACTIVE },
    );
    if (cloned.exitCode !== 0) {
      throw new Error(
        `git clone failed for "${spec.repoFullName}" (exit ${cloned.exitCode}). ` +
          `Check the repo exists and is public. Details: ${cloned.stderr.trim()}`,
      );
    }

    // Best-effort checkout of a specific commit when one was requested.
    if (spec.sha && spec.sha !== "HEAD" && /^[0-9a-f]{7,40}$/i.test(spec.sha)) {
      const fetched = await runProcess(
        "git",
        ["-c", "credential.helper=", "fetch", "--depth", "1", "origin", spec.sha],
        { cwd: this.workdir, timeoutMs: 120_000, env: GIT_NONINTERACTIVE },
      );
      if (fetched.exitCode === 0) {
        await runProcess("git", ["checkout", "--quiet", spec.sha], {
          cwd: this.workdir,
          timeoutMs: 60_000,
        });
      }
    }
  }

  async exec(command: string, options: ExecOptions): Promise<ExecResult> {
    const cwd = options.cwd ? this.resolveInside(options.cwd) : this.workdir;
    const res = await runProcess(command, [], {
      cwd,
      timeoutMs: options.timeoutMs,
      env: options.env,
      shell: true,
    });
    return {
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      timedOut: res.timedOut,
    };
  }

  async readFile(relPath: string): Promise<string> {
    return fs.readFile(this.resolveInside(relPath), "utf8");
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = this.resolveInside(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  async list(): Promise<string[]> {
    const acc: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          await walk(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          acc.push(toPosix(path.relative(this.workdir, path.join(dir, entry.name))));
        }
      }
    };
    await walk(this.workdir);
    acc.sort();
    return acc;
  }

  async dispose(): Promise<void> {
    await fs.rm(this.workdir, { recursive: true, force: true });
  }
}

/**
 * DEV-ONLY provider. Refuses to run when NODE_ENV === "production" so it can
 * never be mistaken for the real isolated sandbox.
 */
export function createLocalDevSandboxProvider(): SandboxProvider {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "LocalSandboxProvider is DEV ONLY and must not run in production. " +
        "Implement the E2B SandboxProvider before deploying.",
    );
  }
  return {
    async create({ runId }) {
      const workdir = path.join(os.tmpdir(), "shipfix-dev", `${runId}-${randomUUID()}`);
      await fs.mkdir(workdir, { recursive: true });
      return new LocalDevSandbox(workdir);
    },
  };
}
