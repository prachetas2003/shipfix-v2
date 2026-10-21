import type { Sandbox } from "@shipfix/sandbox";
import { isWebBackendType } from "@shipfix/contracts";
import { tailLines } from "@shipfix/adapter-core";
import type { FixService, RepairWorkspace } from "@shipfix/autofix";

const INSTALL_TIMEOUT_MS = 8 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const SMOKE_TIMEOUT_MS = 90_000;
const SMOKE_PORT = 18_080;

/** Start the server in the background and wait until something answers on $PORT. */
export function smokeStartScript(start: string, port = SMOKE_PORT): string {
  const probe = `node -e "fetch('http://127.0.0.1:${port}/').then(()=>process.exit(0),()=>process.exit(1))"`;
  return [
    `(${start}) > /tmp/shipfix-start.log 2>&1 &`,
    `for i in $(seq 1 45); do sleep 1; if ${probe}; then echo SHIPFIX_SMOKE_OK; exit 0; fi; done`,
    `echo "The app did not answer on port ${port} within 45 seconds."`,
    `tail -n 150 /tmp/shipfix-start.log`,
    `exit 1`,
  ].join("\n");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The run's sandbox checkout as a {@link RepairWorkspace}: candidate fixes are
 * written here and rebuilt with the service's own commands. Only non-secret
 * env ever reaches the sandbox.
 */
export function sandboxRepairWorkspace(
  sandbox: Sandbox,
  opts: { smokeStart: boolean; posix: boolean },
): RepairWorkspace {
  const run = async (command: string, service: FixService, env: Record<string, string>, timeoutMs: number) => {
    const res = await sandbox.exec(command, {
      ...(service.rootDir ? { cwd: service.rootDir } : {}),
      timeoutMs,
      env: { CI: "1", ...env },
    });
    const log = tailLines(`$ ${command}\n${res.stdout}\n${res.stderr}`.split(/\r?\n/), 200, 16_000);
    if (res.timedOut) return { ok: false, log: `${log}\nThe command timed out after ${Math.round(timeoutMs / 60_000)} minutes.` };
    return { ok: res.exitCode === 0, log };
  };

  return {
    listFiles: () => sandbox.list(),
    async readFile(path) {
      try {
        const text = await sandbox.readFile(path);
        return text.includes("\u0000") ? null : text;
      } catch {
        return null;
      }
    },
    writeFile: (path, content) => sandbox.writeFile(path, content),
    async deleteFile(path) {
      const script = `require('fs').rmSync(${JSON.stringify(path)},{force:true})`;
      await sandbox.exec(`node -e ${opts.posix ? shellQuote(script) : `"${script.replace(/"/g, '\\"')}"`}`, { timeoutMs: 30_000 });
    },
    async verify(service, env) {
      if (service.install) {
        const r = await run(service.install, service, env, INSTALL_TIMEOUT_MS);
        if (!r.ok) return r;
      }
      if (service.build) {
        const r = await run(service.build, service, env, BUILD_TIMEOUT_MS);
        if (!r.ok) return r;
      }
      if (opts.smokeStart && opts.posix && service.start && isWebBackendType(service.type)) {
        const r = await run(smokeStartScript(service.start), service, { ...env, PORT: String(SMOKE_PORT), NODE_ENV: "production" }, SMOKE_TIMEOUT_MS);
        if (!r.ok) return r;
      }
      return { ok: true, log: "Install and build passed in the sandbox." };
    },
  };
}
