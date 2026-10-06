import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ClonedRepo {
  dir: string;
  commitSha: string;
  cleanup: () => Promise<void>;
}

export interface CloneOptions {
  ref?: string;
  timeoutMs?: number;
  /** Optional token for private repos / higher rate limits. Never logged. */
  token?: string;
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function exec(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? os.homedir(),
        USERPROFILE: process.env.USERPROFILE ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        GIT_TERMINAL_PROMPT: "0",
        GIT_LFS_SKIP_SMUDGE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function redact(text: string, token?: string): string {
  const cleaned = text.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
  return token ? cleaned.split(token).join("***") : cleaned;
}

/**
 * Shallow-clone a public GitHub repo into a temp dir. Cloning never executes
 * repository code: hooks are disabled and LFS smudging is skipped, and the eval
 * only reads files afterwards.
 */
export async function shallowClone(repo: string, opts: CloneOptions = {}): Promise<ClonedRepo> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shipfix-eval-"));
  const cleanup = () => rm(dir, { recursive: true, force: true, maxRetries: 3 });
  const auth = opts.token ? `x-access-token:${opts.token}@` : "";
  const url = `https://${auth}github.com/${repo}.git`;
  const args = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.longpaths=true",
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--no-tags",
    ...(opts.ref ? ["--branch", opts.ref] : []),
    url,
    dir,
  ];
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const res = await exec("git", args, os.tmpdir(), timeoutMs);
  if (res.code !== 0) {
    await cleanup();
    const reason = res.timedOut ? `timed out after ${timeoutMs}ms` : redact(res.stderr.trim(), opts.token);
    throw new Error(`git clone failed: ${reason.slice(0, 500)}`);
  }
  const sha = await exec("git", ["rev-parse", "HEAD"], dir, 10_000);
  return { dir, commitSha: sha.stdout.trim() || "0".repeat(40), cleanup };
}
