import type { Fix, FixContext, FileEdit, PlanEdit } from "../types";
import { allDeps, joinRoot, parsePackageJson, stringifyLike, type PackageJson } from "../util";
import { unfrozenInstall } from "./install";

interface LoadedPackage {
  path: string;
  text: string;
  pkg: PackageJson;
}

async function loadPackage(ctx: FixContext): Promise<LoadedPackage | null> {
  const path = joinRoot(ctx.service.rootDir, "package.json");
  const text = await ctx.files.readFile(path);
  const pkg = parsePackageJson(text);
  return text && pkg ? { path, text, pkg } : null;
}

function editPackage(loaded: LoadedPackage, mutate: (pkg: PackageJson) => void): FileEdit {
  const next = structuredClone(loaded.pkg);
  mutate(next);
  return { path: loaded.path, before: loaded.text, after: stringifyLike(loaded.text, next) };
}

/** Without `prisma generate` the Prisma client is missing at runtime ("did you run prisma generate?"). */
export async function fixPrismaGenerate(ctx: FixContext): Promise<Fix | null> {
  const loaded = await loadPackage(ctx);
  if (!loaded) return null;
  const deps = allDeps(loaded.pkg);
  if (!deps["prisma"] || !deps["@prisma/client"]) return null;
  const scripts = loaded.pkg.scripts ?? {};
  if (Object.values(scripts).some((s) => /\bprisma\s+generate\b/.test(s))) return null;
  if (/\bprisma\s+generate\b/.test(`${ctx.service.install ?? ""} ${ctx.service.build ?? ""}`)) return null;

  const prefix = ctx.service.rootDir ? `${ctx.service.rootDir}/` : "";
  const schemas = (await ctx.files.listFiles()).filter(
    (f) => f.startsWith(prefix) && /(^|\/)schema\.prisma$/.test(f) && !f.includes("node_modules/"),
  );
  if (schemas.length !== 1) return null;
  const rel = schemas[0]!.slice(prefix.length);
  const generate = rel === "prisma/schema.prisma" ? "prisma generate" : `prisma generate --schema ${rel}`;
  const existing = scripts["postinstall"];

  return {
    id: "prisma-generate",
    title: "Generate the Prisma client after install",
    explanation: `The app uses Prisma, but nothing runs \`prisma generate\` on the build server, so the database client would be missing when the app starts. Added it to the \`postinstall\` script in ${loaded.path}.`,
    files: [
      editPackage(loaded, (pkg) => {
        pkg.scripts = { ...(pkg.scripts ?? {}), postinstall: existing ? `${generate} && ${existing}` : generate };
      }),
    ],
    plan: [],
  };
}

const DEFAULT_NODE_MAJOR = 22;

/** Pull the Node major a log says the project needs ("requires Node >=20", 'Expected version ">=18.18.0"'). */
export function requiredNodeMajor(evidence: string): number | null {
  const patterns = [
    /Expected version "([^"]+)"/i,
    /Node(?:\.js)?\s+(?:version\s+)?([<>=^~ ]*v?\d+(?:\.\d+)*(?:\s*\|\|\s*[<>=^~ ]*\d+(?:\.\d+)*)*)\s+(?:or (?:higher|later|newer)|is required)/i,
    /requires? (?:a )?Node(?:\.js)?(?: version)?\s+(?:of\s+)?([<>=^~ ]*v?\d+(?:\.\d+)*)/i,
    /"node":\s*"([^"]+)"/,
  ];
  for (const re of patterns) {
    const range = re.exec(evidence)?.[1];
    if (!range) continue;
    const majors = [...range.matchAll(/(\d+)(?:\.\d+)*/g)].map((m) => Number(m[1]));
    if (majors.length) return Math.max(...majors);
  }
  return null;
}

/** Pin the Node version the build log asked for, never older than the current LTS. */
export async function fixNodeEngines(ctx: FixContext, evidence: string): Promise<Fix | null> {
  const loaded = await loadPackage(ctx);
  if (!loaded) return null;
  const major = Math.max(requiredNodeMajor(evidence) ?? DEFAULT_NODE_MAJOR, DEFAULT_NODE_MAJOR);
  const range = `${major}.x`;
  if (loaded.pkg.engines?.["node"] === range) return null;
  return {
    id: "node-engines",
    title: `Build with Node ${major}`,
    explanation: `The build failed because a package needs a newer Node.js than the build server used by default. Setting \`engines.node\` to "${range}" in ${loaded.path} tells the host which version to install.`,
    files: [editPackage(loaded, (pkg) => void (pkg.engines = { ...(pkg.engines ?? {}), node: range }))],
    plan: [],
  };
}

const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram",
  "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream", "string_decoder",
  "sys", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/** "@scope/pkg/sub/path" → "@scope/pkg"; null for relative paths, aliases, builtins and invalid names. */
export function packageNameOf(specifier: string): string | null {
  const s = specifier.trim().replace(/^['"]|['"]$/g, "");
  if (!s || s.startsWith(".") || s.startsWith("/") || s.startsWith("node:") || /^[~#@]\//.test(s)) return null;
  const parts = s.split("/");
  const name = s.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name)) return null;
  if (NODE_BUILTINS.has(name)) return null;
  return name;
}

async function lockedVersion(ctx: FixContext, name: string): Promise<string | null> {
  for (const dir of ctx.service.rootDir ? [ctx.service.rootDir, ""] : [""]) {
    const text = await ctx.files.readFile(joinRoot(dir, "package-lock.json"));
    if (!text) continue;
    try {
      const lock = JSON.parse(text) as { packages?: Record<string, { version?: string }> };
      const v = lock.packages?.[`node_modules/${name}`]?.version;
      if (v) return v;
    } catch {
      /* unreadable lockfile: fall through to the registry */
    }
  }
  return null;
}

async function registryVersion(ctx: FixContext, name: string): Promise<string | null> {
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/** A package the code imports but package.json never declared (it only worked from a global or hoisted install). */
export async function fixMissingDependency(ctx: FixContext, subject: string | null | undefined): Promise<Fix | null> {
  const name = subject ? packageNameOf(subject) : null;
  if (!name) return null;
  const loaded = await loadPackage(ctx);
  if (!loaded || allDeps(loaded.pkg)[name]) return null;
  const version = (await lockedVersion(ctx, name)) ?? (await registryVersion(ctx, name));
  if (!version) return null;

  const dev = name.startsWith("@types/");
  const plan: PlanEdit[] = [];
  const install = unfrozenInstall(ctx.service.install);
  if (install) plan.push({ serviceId: ctx.service.id, field: "install", from: ctx.service.install, to: install });

  return {
    id: "missing-dependency",
    title: `Add the missing package ${name}`,
    explanation: `The code imports \`${name}\`, but it isn't listed in ${loaded.path}, so the build server never installs it. Added \`${name}@^${version}\` to ${dev ? "devDependencies" : "dependencies"}.${install ? " The install command no longer insists the lockfile already matches, so the new package can be installed." : ""}`,
    files: [
      editPackage(loaded, (pkg) => {
        const key = dev ? "devDependencies" : "dependencies";
        pkg[key] = sortKeys({ ...(pkg[key] ?? {}), [name]: `^${version}` });
      }),
    ],
    plan,
  };
}

function sortKeys(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

const ENTRY_CANDIDATES = ["server.js", "index.js", "app.js", "main.js", "src/server.js", "src/index.js", "src/app.js"];

/** `npm run start` / `npm run build` with no such script in package.json. */
export async function fixMissingScript(ctx: FixContext, subject: string | null | undefined): Promise<Fix | null> {
  const script = subject?.trim();
  if (script !== "start" && script !== "build") return null;
  const loaded = await loadPackage(ctx);
  if (!loaded || loaded.pkg.scripts?.[script]) return null;
  const deps = allDeps(loaded.pkg);
  let command: string | null = null;

  if (script === "start" && ctx.service.type === "node_api") {
    const files = new Set(await ctx.files.listFiles());
    const main = typeof loaded.pkg.main === "string" ? loaded.pkg.main.replace(/^\.\//, "") : null;
    const entry = [main, ...ENTRY_CANDIDATES].find(
      (f): f is string => !!f && /\.[cm]?js$/.test(f) && files.has(joinRoot(ctx.service.rootDir, f)),
    );
    if (entry) command = `node ${entry}`;
  } else if (script === "build") {
    if (deps["next"]) command = "next build";
    else if (deps["vite"]) command = "vite build";
  }
  if (!command) return null;

  return {
    id: "missing-script",
    title: `Add a "${script}" script`,
    explanation: `The host runs \`npm run ${script}\`, but ${loaded.path} has no "${script}" script. Added \`"${script}": "${command}"\`.`,
    files: [editPackage(loaded, (pkg) => void (pkg.scripts = { ...(pkg.scripts ?? {}), [script]: command }))],
    plan: [],
  };
}
