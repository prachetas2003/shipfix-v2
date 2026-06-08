import { z } from "zod";

/**
 * Run events — the append-only, ordered timeline of a Run.
 *
 * This single stream powers BOTH the live UI (tailed over SSE) and the audit
 * trail. Every message/data payload MUST be redacted before it is emitted:
 * no secret values, ever.
 */

/** The lifecycle stages a run moves through. Mirrors the workflow state machine. */
export const RunStage = z.enum([
  "queued",
  "analyzing", // clone in sandbox + build RepoContext
  "planning", // LLM -> DeploymentPlan
  "validating", // run install/build in sandbox; prove commands
  "awaiting_input", // human-in-the-loop questions
  "provisioning", // managed services (DB/Redis)
  "deploying", // provider deploys
  "wiring", // resolve + inject generated env
  "verifying", // live checks
  "succeeded",
  "diagnosed", // could not deploy; diagnosis delivered
  "failed",
]);
export type RunStage = z.infer<typeof RunStage>;

export const RunEventType = z.enum([
  "stage", // a stage started/changed
  "log", // a (redacted) log line
  "decision", // planner/recovery decision
  "question", // a PlanQuestion surfaced to the user
  "verification", // a verification check result
  "error",
]);
export type RunEventType = z.infer<typeof RunEventType>;

export const RunEventLevel = z.enum(["debug", "info", "warn", "error"]);
export type RunEventLevel = z.infer<typeof RunEventLevel>;

export const RunEvent = z.object({
  runId: z.string().uuid(),
  /** Monotonic per-run sequence number for strict ordering. */
  seq: z.number().int().nonnegative(),
  type: RunEventType,
  stage: RunStage.optional(),
  level: RunEventLevel.default("info"),
  /** Already redacted. */
  message: z.string(),
  /** Already-redacted structured payload. */
  data: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
});
export type RunEvent = z.infer<typeof RunEvent>;

/** Input shape callers use to emit an event (seq/createdAt assigned by sink). */
export const RunEventInput = RunEvent.omit({ seq: true, createdAt: true });
export type RunEventInput = z.infer<typeof RunEventInput>;
