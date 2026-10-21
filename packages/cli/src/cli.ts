import { runShipfix } from "./run.ts";

const code = await runShipfix({
  argv: process.argv.slice(2),
  env: process.env,
  fetchImpl: fetch,
  write: (line) => process.stdout.write(`${line}\n`),
  writeErr: (line) => process.stderr.write(`${line}\n`),
});
process.exitCode = code;
