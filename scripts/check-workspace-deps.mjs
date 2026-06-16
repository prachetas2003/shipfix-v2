import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageDirs = [
  ...workspaceDirs("apps"),
  ...workspaceDirs("packages"),
  ...workspaceDirs(join("packages", "adapters")),
];

function workspaceDirs(parent) {
  const base = join(root, parent);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((name) => join(base, name))
    .filter((dir) => existsSync(join(dir, "package.json")));
}

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    if (["node_modules", "dist", "build", ".next", "coverage", "drizzle"].includes(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    if (stat.isFile() && /\.(tsx?|mts|cts)$/.test(entry)) files.push(full);
  }
  return files;
}

function workspacePackageName(specifier) {
  const match = specifier.match(/^@shipfix\/[^/]+/);
  return match?.[0] ?? null;
}

function importedWorkspacePackages(source) {
  const specs = new Set();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["'](@shipfix\/[^"']+)["']/g,
    /\bexport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["'](@shipfix\/[^"']+)["']/g,
    /\bimport\(["'](@shipfix\/[^"']+)["']\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const pkg = workspacePackageName(match[1]);
      if (pkg) specs.add(pkg);
    }
  }
  return specs;
}

const packageNames = new Set(
  packageDirs.map((dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name),
);

const offenders = [];
for (const dir of packageDirs) {
  const pkgJsonPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    pkg.name,
  ]);

  for (const file of walk(dir)) {
    const source = readFileSync(file, "utf8");
    for (const imported of importedWorkspacePackages(source)) {
      if (!packageNames.has(imported) || declared.has(imported)) continue;
      offenders.push(`${relative(root, file)} imports ${imported}, but ${relative(root, pkgJsonPath)} does not declare it`);
    }
  }
}

if (offenders.length > 0) {
  console.error("Workspace dependency boundary violations:");
  for (const offender of offenders) console.error(`- ${offender}`);
  process.exit(1);
}

console.log("Workspace dependency declarations look good.");
