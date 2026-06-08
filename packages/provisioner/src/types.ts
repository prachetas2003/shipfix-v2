import type { ManagedKind, ManagedService } from "@shipfix/contracts";

/** Managed-service providers (mirrors DeploymentPlan's ManagedService.provider). */
export type ManagedProviderId = "neon" | "supabase" | "upstash";

/** Decrypted, just-in-time credentials for a single provisioner call. */
export interface ProvisionerCredentials {
  provider: ManagedProviderId;
  /** Opaque bag (e.g. { apiKey }). Never logged; resolved by the worker vault. */
  values: Record<string, string>;
}

export interface ProvisionInput {
  /** Stable, deterministic name so re-provisioning is recognizable at the provider. */
  resourceName: string;
  managed: ManagedService;
  credentials: ProvisionerCredentials;
  /** Redacted log lines streamed to run_events. */
  onLog?: (line: string) => void;
}

/** A secret env var a resource exposes (e.g. DATABASE_URL). The VALUE is secret. */
export interface ExposedEnv {
  name: string;
  value: string;
}

export type ProvisionStatus = "live" | "failed";

export interface ProvisionResult {
  ok: boolean;
  /** Provider resource id, for verification/teardown/reconcile. */
  externalId: string | null;
  /** Non-secret host (safe to persist in deployed_resources.url / log). */
  host: string | null;
  /** Secret env this resource exposes — the caller SEALS this before storage. */
  exposed: ExposedEnv | null;
  status: ProvisionStatus;
  /** Log tail (already provider-side; caller still redacts before persisting). */
  logs: string;
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
}

/**
 * The uniform contract over managed-service providers (Neon/Upstash/Supabase).
 *
 * API-based and idempotency-aware; receives decrypted credentials at call time
 * and never reads the vault or the database itself.
 */
export interface ManagedProvisioner {
  readonly id: ManagedProviderId;
  readonly kinds: ReadonlyArray<ManagedKind>;
  requiredCredentials(): { required: string[]; optional?: string[] };
  provision(input: ProvisionInput): Promise<ProvisionResult>;
  /** Prove the resource is actually reachable (e.g. SELECT 1). */
  verify(exposed: ExposedEnv): Promise<VerifyResult>;
  teardown(externalId: string, credentials: ProvisionerCredentials): Promise<void>;
}

/** Resolve a provisioner by provider id. */
export class ProvisionerRegistry {
  private readonly provisioners = new Map<ManagedProviderId, ManagedProvisioner>();

  register(p: ManagedProvisioner): void {
    this.provisioners.set(p.id, p);
  }

  get(id: ManagedProviderId): ManagedProvisioner | undefined {
    return this.provisioners.get(id);
  }

  has(id: ManagedProviderId): boolean {
    return this.provisioners.has(id);
  }

  ids(): ManagedProviderId[] {
    return [...this.provisioners.keys()];
  }

  /** True if this registry can provision `kind` via `provider`. */
  supports(provider: ManagedProviderId, kind: ManagedKind): boolean {
    const p = this.provisioners.get(provider);
    return !!p && p.kinds.includes(kind);
  }
}

export type { ManagedService };
