/**
 * Production sandbox: one fresh E2B microVM per run.
 *
 * Isolation comes from E2B (Firecracker VM, non-root `user`, destroyed on dispose)
 * plus an egress allowlist: by default only GitHub and package registries are
 * reachable, so repo code cannot call back into the control plane.
 */
import { CommandExitError, Sandbox as E2BSandbox, TimeoutError } from "e2b";
import path from "node:path";
import type { CloneSpec, ExecOptions, ExecResult, Sandbox, SandboxProvider } from "./index";
import { parseResolvedAddresses, safeLookupHosts } from "./egress";
import { buildSandboxEnv } from "./env";
import { IGNORED_DIRS } from "./ignored";

const LOOKUP_ADDRESSES =
  'import dns from "node:dns/promises"; const hosts = (process.env.HOSTS ?? "").split(",").filter(Boolean); const out = []; for (const host of hosts) { try { for (const row of await dns.lookup(host, { all: true })) out.push(row.address); } catch {} } console.log(out.join(" "));';

const WORKDIR = "/home/user/repo";

export const DEFAULT_EGRESS_ALLOW = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "binaries.prisma.sh",
  "nodejs.org",
];

export interface E2BProviderConfig {
  apiKey: string;
  template?: string;
  /** Extra egress hosts applied to every sandbox (e.g. a private registry mirror). */
  extraEgressAllow?: string[];
  defaultWallClockMs?: number;
}

function toResult(res: { exitCode: number; stdout: string; stderr: string }, timedOut = false): ExecResult {
  return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, timedOut };
}

class E2BRunSandbox implements Sandbox {
  constructor(
    private readonly vm: E2BSandbox,
    private allowOut: string[],
  ) {}

  private resolveInside(relPath: string): string {
    const abs = path.posix.resolve(WORKDIR, relPath);
    if (abs !== WORKDIR && !abs.startsWith(`${WORKDIR}/`)) {
      throw new Error(`Path escapes sandbox workspace: ${relPath}`);
    }
    return abs;
  }

  private async run(
    command: string,
    opts: { cwd?: string; timeoutMs: number; env?: Record<string, string> },
  ): Promise<ExecResult> {
    try {
      const res = await this.vm.commands.run(command, {
        cwd: opts.cwd ?? WORKDIR,
        timeoutMs: opts.timeoutMs,
        envs: buildSandboxEnv(opts.env, {}),
      });
      return toResult(res);
    } catch (err) {
      if (err instanceof CommandExitError) return toResult(err);
      if (err instanceof TimeoutError) {
        return { exitCode: -1, stdout: "", stderr: String(err.message), timedOut: true };
      }
      throw err;
    }
  }

  async clone(spec: CloneSpec): Promise<void> {
    await this.run(`mkdir -p ${WORKDIR}`, { cwd: "/home/user", timeoutMs: 10_000 });
    const auth = spec.token ? `x-access-token:${spec.token}@` : "";
    const url = `https://${auth}github.com/${spec.repoFullName}.git`;
    const git = { GIT_TERMINAL_PROMPT: "0" };
    const cloned = await this.run(`git -c credential.helper= clone --depth 1 '${url}' .`, {
      timeoutMs: 120_000,
      env: git,
    });
    if (cloned.exitCode !== 0) {
      const detail = cloned.stderr.replace(/x-access-token:[^@]+@/g, "x-access-token:***@").trim();
      throw new Error(
        `git clone failed for "${spec.repoFullName}" (exit ${cloned.exitCode}). ` +
          `Check the repo exists and ShipFix has access. Details: ${detail}`,
      );
    }
    if (spec.sha && spec.sha !== "HEAD" && /^[0-9a-f]{7,40}$/i.test(spec.sha)) {
      const fetched = await this.run(`git -c credential.helper= fetch --depth 1 origin ${spec.sha}`, {
        timeoutMs: 120_000,
        env: git,
      });
      if (fetched.exitCode === 0) {
        await this.run(`git checkout --quiet ${spec.sha}`, { timeoutMs: 60_000 });
      }
    }
  }

  exec(command: string, options: ExecOptions): Promise<ExecResult> {
    const cwd = options.cwd ? this.resolveInside(options.cwd) : WORKDIR;
    return this.run(command, { cwd, timeoutMs: options.timeoutMs, env: options.env });
  }

  async readFile(relPath: string): Promise<string> {
    return this.vm.files.read(this.resolveInside(relPath));
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    await this.vm.files.write(this.resolveInside(relPath), content);
  }

  async list(): Promise<string[]> {
    const prune = [...IGNORED_DIRS].map((d) => `-name '${d}'`).join(" -o ");
    const res = await this.run(`find . \\( ${prune} \\) -prune -o -type f -print`, {
      timeoutMs: 60_000,
    });
    if (res.exitCode !== 0) throw new Error(`Listing sandbox files failed: ${res.stderr.trim()}`);
    return res.stdout
      .split("\n")
      .map((l) => l.trim().replace(/^\.\//, ""))
      .filter((l) => l.length > 0 && l !== ".")
      .sort();
  }

  async allowResolvedAddresses(hosts: string[]): Promise<number> {
    const clean = safeLookupHosts(hosts);
    if (clean.length === 0) return 0;
    const looked = await this.run(`node --input-type=module -e ${JSON.stringify(LOOKUP_ADDRESSES)}`, {
      cwd: "/home/user",
      timeoutMs: 20_000,
      env: { HOSTS: clean.join(",") },
    });
    const ips = parseResolvedAddresses(looked.stdout);
    if (ips.length === 0) return 0;
    this.allowOut = [...new Set([...this.allowOut, ...ips])];
    await this.vm.updateNetwork({
      allowOut: this.allowOut,
      denyOut: ({ allTraffic }) => [allTraffic],
    });
    return ips.length;
  }

  async dispose(): Promise<void> {
    await this.vm.kill().catch(() => undefined);
  }
}

export function createE2BSandboxProvider(config: E2BProviderConfig): SandboxProvider {
  return {
    async create(opts) {
      const allow = [...DEFAULT_EGRESS_ALLOW, ...(config.extraEgressAllow ?? []), ...(opts.egressAllow ?? [])];
      const vm = await E2BSandbox.create(config.template ?? "base", {
        apiKey: config.apiKey,
        timeoutMs: opts.wallClockMs ?? config.defaultWallClockMs ?? 30 * 60_000,
        metadata: { runId: opts.runId, app: "shipfix" },
        network: {
          allowOut: [...new Set(allow)],
          denyOut: ({ allTraffic }) => [allTraffic],
        },
      });
      return new E2BRunSandbox(vm, [...new Set(allow)]);
    },
  };
}
