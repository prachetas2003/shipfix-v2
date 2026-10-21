#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error("shipfix needs Node.js 22 or newer.");
  process.exit(1);
}

const dir = dirname(fileURLToPath(import.meta.url));
const child = spawn(
  process.execPath,
  ["--experimental-strip-types", join(dir, "../src/cli.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
