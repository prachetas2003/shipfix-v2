import type { RunEventInput } from "@shipfix/contracts";
import type { Database } from "@shipfix/db";
import { sql } from "drizzle-orm";
import type { RunEventSink } from "./types.js";

const MAX_SEQ_RETRIES = 8;

/** Postgres unique_violation — concurrent seq assignment on the same run. */
export function isRunEventsSeqConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code =
    "code" in err && typeof (err as { code: unknown }).code === "string"
      ? (err as { code: string }).code
      : null;
  if (code === "23505") return true;
  const cause = "cause" in err ? (err as { cause: unknown }).cause : null;
  if (cause && typeof cause === "object" && "code" in cause) {
    return (cause as { code: string }).code === "23505";
  }
  const message = err instanceof Error ? err.message : String(err);
  return /run_events_seq_unique|duplicate key.*\(run_id, seq\)/i.test(message);
}

/**
 * Per-process serialization: concurrent `emit()` calls for the same run are
 * queued so only one INSERT runs at a time in this worker. Combined with the
 * advisory lock inside {@link insertRunEventRow}, this prevents the
 * MAX(seq)+1 race that caused duplicate `(run_id, seq)` crashes.
 */
const emitChains = new Map<string, Promise<void>>();

function serializeRunEmit(runId: string, fn: () => Promise<void>): Promise<void> {
  const prev = emitChains.get(runId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  emitChains.set(runId, next);
  void next.finally(() => {
    if (emitChains.get(runId) === next) emitChains.delete(runId);
  });
  return next;
}

/**
 * Atomically assign the next seq under a per-run advisory lock, with bounded
 * retry if a unique violation still occurs (e.g. cross-worker races).
 */
export async function insertRunEventRow(db: Database, event: RunEventInput): Promise<void> {
  const dataJson = event.data ? JSON.stringify(event.data) : null;

  for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
    try {
      await db.transaction(async (tx) => {
        // One writer per run_id for the duration of this INSERT.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${event.runId}::text))`);
        await tx.execute(sql`
          INSERT INTO run_events (run_id, seq, type, stage, level, message, data, created_at)
          SELECT
            ${event.runId}::uuid,
            COALESCE(MAX(seq), -1) + 1,
            ${event.type},
            ${event.stage ?? null},
            ${event.level ?? "info"},
            ${event.message},
            ${dataJson}::jsonb,
            now()
          FROM run_events
          WHERE run_id = ${event.runId}::uuid
        `);
      });
      return;
    } catch (err) {
      if (!isRunEventsSeqConflict(err) || attempt === MAX_SEQ_RETRIES - 1) throw err;
    }
  }
}

/** Postgres sink with per-run serialization and seq-conflict retry. */
export function createPostgresSink(db: Database): RunEventSink {
  return {
    async emit(event) {
      await serializeRunEmit(event.runId, () => insertRunEventRow(db, event));
    },
  };
}

/**
 * Wrap any sink so emit failures never propagate to deployment activities.
 * Errors are logged to stderr; the deployment workflow continues.
 */
export function createNonFatalSink(inner: RunEventSink): RunEventSink {
  return {
    async emit(event) {
      try {
        await inner.emit(event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(
          `[shipfix] run_events persist failed run=${event.runId} type=${event.type}: ${msg}`,
        );
      }
    },
  };
}

/** Production sink: race-safe seq + non-fatal for workflow reliability. */
export function createSafePostgresSink(db: Database): RunEventSink {
  return createNonFatalSink(createPostgresSink(db));
}
