/**
 * @shipfix/adapter-render — real Render REST adapter for node_api backends.
 *
 * API-based, idempotent (stable service name), no CLI stdout parsing. Receives
 * fully resolved env at deploy time; never reads the vault or database.
 */
export { createRenderAdapter, type RenderOptions } from "./render";
