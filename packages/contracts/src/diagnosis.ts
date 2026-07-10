import { z } from "zod";

/**
 * Structured runtime diagnosis — precise failure objects the UI can render.
 * Never includes secret values.
 */
export const DiagnosisCode = z.enum([
  "cors_failed",
  "db_unreachable",
  "health_failed",
  "migration_failed",
  "env_unresolved",
]);
export type DiagnosisCode = z.infer<typeof DiagnosisCode>;

export const StructuredDiagnosis = z.object({
  code: DiagnosisCode,
  /** Human-readable next step (safe to show). */
  action: z.string(),
  fromServiceId: z.string().optional(),
  toServiceId: z.string().optional(),
  serviceId: z.string().optional(),
  managedId: z.string().optional(),
  fromUrl: z.string().nullable().optional(),
  toUrl: z.string().nullable().optional(),
  evidence: z.record(z.unknown()).optional(),
});
export type StructuredDiagnosis = z.infer<typeof StructuredDiagnosis>;
