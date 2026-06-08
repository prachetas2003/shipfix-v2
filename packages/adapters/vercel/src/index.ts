/**
 * @shipfix/adapter-vercel — real Vercel REST adapter for frontend_static deploys.
 *
 * API-based, idempotent (stable project name), no CLI stdout parsing. Receives
 * fully resolved env at deploy time; never reads the vault or database.
 */
export { createVercelAdapter, type VercelOptions } from "./vercel";
