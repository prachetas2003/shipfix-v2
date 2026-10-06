/**
 * Worker-only entry point that picks the sandbox implementation for this process.
 *
 *   SHIPFIX_SANDBOX=e2b    E2B microVMs (required in production; needs E2B_API_KEY)
 *   SHIPFIX_SANDBOX=local  host-side dev sandbox (refused when NODE_ENV=production)
 *
 * When unset: e2b if E2B_API_KEY is present, otherwise local.
 */
import type { SandboxProvider } from "./index";
import { createE2BSandboxProvider } from "./e2bProvider";
import { createLocalDevSandboxProvider } from "./localDevProvider";

export type SandboxKind = "e2b" | "local";

export function resolveSandboxKind(env: NodeJS.ProcessEnv = process.env): SandboxKind {
  const explicit = env.SHIPFIX_SANDBOX?.trim().toLowerCase();
  if (explicit === "e2b" || explicit === "local") return explicit;
  if (explicit) throw new Error(`Unknown SHIPFIX_SANDBOX "${explicit}". Use "e2b" or "local".`);
  return env.E2B_API_KEY?.trim() ? "e2b" : "local";
}

export function createRunSandboxProvider(env: NodeJS.ProcessEnv = process.env): SandboxProvider {
  const kind = resolveSandboxKind(env);
  if (kind === "local") {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "The local sandbox runs repo code on the worker host and is refused in production. " +
          "Set SHIPFIX_SANDBOX=e2b and E2B_API_KEY on the worker.",
      );
    }
    return createLocalDevSandboxProvider();
  }
  const apiKey = env.E2B_API_KEY?.trim();
  if (!apiKey) throw new Error("SHIPFIX_SANDBOX=e2b requires E2B_API_KEY on the worker.");
  const extra = (env.SHIPFIX_SANDBOX_EGRESS_ALLOW ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return createE2BSandboxProvider({
    apiKey,
    template: env.E2B_TEMPLATE?.trim() || undefined,
    extraEgressAllow: extra,
  });
}
