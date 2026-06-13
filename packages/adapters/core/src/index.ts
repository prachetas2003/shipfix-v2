import type { PlanProvider, PlanService, ServiceType } from "@shipfix/contracts";

/**
 * @shipfix/adapter-core — the uniform contract over every deploy target.
 *
 * Design rules:
 *  - API-based and state-reconciling. NO CLI-stdout scraping (the v1 Vercel
 *    adapter's fragility).
 *  - `deploy` is idempotent: create-or-update by stable name so workflow retries
 *    are safe.
 *  - Adapters receive already-resolved, decrypted env at call time; they never
 *    read the vault or touch the database.
 *  - This package contains the INTERFACE ONLY. Concrete adapters live in
 *    `@shipfix/adapter-vercel`, `@shipfix/adapter-render`, etc.
 */

/** Decrypted, just-in-time credentials for a single provider call. */
export interface ProviderCredentials {
  provider: PlanProvider;
  /** Opaque bag (token, ownerId, ...). Never logged; resolved by the worker. */
  values: Record<string, string>;
}

export interface CredentialSpec {
  provider: PlanProvider;
  /** Field names the connect UI must collect (for validation + onboarding). */
  required: string[];
  optional?: string[];
}

export interface DeployInput {
  service: PlanService;
  repo: { fullName: string; branch: string; /** Pin git deployments to a commit when set. */ commitSha?: string };
  rootDir: string;
  /** Stable provider resource name for idempotent create-or-update. */
  resourceName?: string;
  /** Fully resolved (wiring + secrets) env to apply at the provider. */
  env: Record<string, string>;
  credentials: ProviderCredentials;
  /** Redacted log lines streamed to run_events. */
  onLog?: (line: string) => void;
}

export type DeployStatus = "live" | "build_failed" | "deploy_failed" | "timeout";

/** Why a deploy failed — drives terminal outcome and UI messaging. */
export type DeployFailureKind = "setup_blocker" | "deploy_failed" | "build_failed" | "timeout";

export interface DeployResult {
  ok: boolean;
  externalId: string | null; // provider resource id (for reconcile/teardown)
  publicUrl: string | null;
  status: DeployStatus;
  /** Log tail for the recovery classifier. */
  logs: string;
  /** When ok is false, distinguishes account setup from hard deploy failure. */
  failureKind?: DeployFailureKind;
}

export interface ProviderAdapter {
  readonly id: PlanProvider;
  /** Which service types this adapter can deploy. */
  readonly supports: ReadonlyArray<ServiceType>;

  requiredCredentials(): CredentialSpec;

  /** Create-or-update by stable name; idempotent across workflow retries. */
  deploy(input: DeployInput): Promise<DeployResult>;

  /** Poll a provider resource until terminal. */
  waitForReady(
    externalId: string,
    credentials: ProviderCredentials,
  ): Promise<DeployResult>;

  /** Update env on an existing service without a full redeploy (rewiring). */
  setEnv(
    externalId: string,
    env: Record<string, string>,
    credentials: ProviderCredentials,
  ): Promise<void>;

  teardown(externalId: string, credentials: ProviderCredentials): Promise<void>;
}

/** Simple registry so the executor can resolve an adapter by provider id. */
export class AdapterRegistry {
  private readonly adapters = new Map<PlanProvider, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(provider: PlanProvider): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`No adapter registered for provider "${provider}".`);
    }
    return adapter;
  }

  has(provider: PlanProvider): boolean {
    return this.adapters.has(provider);
  }
}

// Concrete adapters: @shipfix/adapter-render (node_api), @shipfix/adapter-vercel (frontend_static).

export { preflightProviderCredentials, type PreflightResult } from "./preflight";
