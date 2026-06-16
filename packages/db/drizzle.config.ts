import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";
import { databaseFingerprint, loadShipfixEnv } from "./src/env";

const rootEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));
const appLocalEnvPath = fileURLToPath(new URL(".env.local", import.meta.url));
const envLoad = loadShipfixEnv({
  rootEnvPath,
  appLocalEnvPath,
  rootOverride: process.env.NODE_ENV !== "production",
});
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required for ShipFix DB commands. Put it in repo-root .env or packages/db/.env.local, then rerun the command.",
  );
}

const fp = databaseFingerprint(databaseUrl);
// eslint-disable-next-line no-console
console.log("[shipfix-db] database fingerprint", {
  databaseUrlPresent: fp.databaseUrlPresent,
  hostHash: fp.hostHash,
  hostRedacted: fp.hostRedacted,
  databaseName: fp.databaseName,
  envSourcePath: envLoad.envSourcePath,
  rootEnvOverride: envLoad.rootEnvOverride,
});

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
