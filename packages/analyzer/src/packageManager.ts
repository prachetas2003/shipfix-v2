import type { PackageManager } from "@shipfix/contracts";
import { joinRoot } from "./util";

/**
 * Lockfile -> package manager. A repo can technically contain several; the
 * order here encodes confidence (a pnpm-lock is the strongest signal).
 */
const LOCKFILES: ReadonlyArray<[file: string, pm: PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/** Ancestor dirs of `dir`, from the dir itself up to the repo root (""). */
function ancestorsInclusive(dir: string): string[] {
  const chain: string[] = [];
  let current = dir;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    chain.push(current);
    if (current === "") break;
    const idx = current.lastIndexOf("/");
    current = idx === -1 ? "" : current.slice(0, idx);
  }
  return chain;
}

/**
 * Detect the package manager governing a given service dir by finding the
 * nearest lockfile walking upward. Falls back to a `packageManager` field, then
 * to npm (the default for a Node service with no lockfile).
 */
export function detectPackageManager(
  files: ReadonlySet<string>,
  dir: string,
  rootPackageManagerField?: string,
): PackageManager {
  for (const ancestor of ancestorsInclusive(dir)) {
    for (const [lockfile, pm] of LOCKFILES) {
      if (files.has(joinRoot(ancestor, lockfile))) return pm;
    }
  }

  if (rootPackageManagerField) {
    const name = rootPackageManagerField.split("@")[0];
    if (name === "pnpm" || name === "yarn" || name === "bun" || name === "npm") {
      return name;
    }
  }

  return "npm";
}
