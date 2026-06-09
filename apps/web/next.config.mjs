import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Next loads env files from the app directory by default. ShipFix keeps local
// monorepo config at the repo root, so copy only safe public values from there.
// Do not load backend secrets into the web dev process.
const rootEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnvPath)) {
  for (const rawLine of readFileSync(rootEnvPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key.startsWith("NEXT_PUBLIC_") || process.env[key]) continue;
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    process.env[key] = value;
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the workspace root so Next doesn't pick up stray lockfiles elsewhere.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  // TODO: add `transpilePackages: ["@shipfix/contracts"]` when the UI starts
  // importing shared workspace types/schemas.
};

export default nextConfig;
