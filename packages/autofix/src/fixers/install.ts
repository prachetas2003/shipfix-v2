import type { Fix, FixContext } from "../types";
import { joinRoot } from "../util";

/** Relax a frozen-lockfile install; null when it isn't frozen. */
export function unfrozenInstall(install: string | null): string | null {
  if (!install) return null;
  const next = install
    .replace(/\bnpm\s+ci\b/g, "npm install")
    .replace(/\s+--frozen-lockfile\b/g, "")
    .replace(/\s+--immutable\b/g, "")
    .replace(/\bpnpm\s+install\b(?![^&|;]*--no-frozen-lockfile)/g, "pnpm install --no-frozen-lockfile");
  return next === install ? null : next;
}

/** package.json and the lockfile disagree, so a strict install refuses to run. */
export async function fixLockfileInstall(ctx: FixContext): Promise<Fix | null> {
  const install = unfrozenInstall(ctx.service.install);
  if (!install) return null;
  return {
    id: "lockfile-install",
    title: "Install even when the lockfile is out of date",
    explanation: `The lockfile doesn't match package.json, so \`${ctx.service.install}\` refuses to install. ShipFix now runs \`${install}\`, which updates the lockfile on the build server. Regenerating the lockfile locally and committing it makes builds reproducible again.`,
    files: [],
    plan: [{ serviceId: ctx.service.id, field: "install", from: ctx.service.install, to: install }],
  };
}

/** npm 7+ fails on peer-dependency conflicts that npm 6 and pnpm only warned about. */
export async function fixLegacyPeerDeps(ctx: FixContext): Promise<Fix | null> {
  const files = await ctx.files.listFiles();
  const root = ctx.service.rootDir;
  const otherManager = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"].some(
    (f) => files.includes(joinRoot(root, f)) || files.includes(f),
  );
  if (otherManager) return null;
  const path = joinRoot(root, ".npmrc");
  const before = await ctx.files.readFile(path);
  if (before && /^\s*legacy-peer-deps\s*=\s*true\s*$/m.test(before)) return null;
  const after = before ? `${before.replace(/\s*$/, "")}\nlegacy-peer-deps=true\n` : "legacy-peer-deps=true\n";
  return {
    id: "legacy-peer-deps",
    title: "Allow packages with conflicting peer dependencies",
    explanation: `npm stopped the install because two packages ask for different versions of a shared dependency. This usually works fine at runtime. Adding \`legacy-peer-deps=true\` to ${path} restores the older, more forgiving install behavior.`,
    files: [{ path, before, after }],
    plan: [],
  };
}

/** Vercel build machines have far more memory than Node uses by default. */
export async function fixBuildMemory(ctx: FixContext): Promise<Fix | null> {
  if (ctx.service.provider !== "vercel") return null;
  return {
    id: "build-memory",
    title: "Give the build more memory",
    explanation: "The build ran out of memory. Node caps its memory well below what the build machine has, so ShipFix raises the cap with NODE_OPTIONS=--max-old-space-size=6144.",
    files: [],
    plan: [{ serviceId: ctx.service.id, env: { name: "NODE_OPTIONS", value: "--max-old-space-size=6144" } }],
  };
}
