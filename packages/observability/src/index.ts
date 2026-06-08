import type { RunEventInput } from "@shipfix/contracts";
import { redact, redactDeep } from "@shipfix/secrets";

export type { RunEventSink, RunLogger } from "./types.js";
export {
  createNonFatalSink,
  createPostgresSink,
  createSafePostgresSink,
  insertRunEventRow,
  isRunEventsSeqConflict,
} from "./postgresSink.js";

/**
 * @shipfix/observability — the run event logger interface.
 *
 * Activities emit events through a RunLogger. Every event is redacted at the
 * boundary so a sink can never persist or stream a secret. Sinks are pluggable
 * (Postgres run_events, console for dev, SSE fan-out).
 */

import type { RunEventSink, RunLogger } from "./types.js";

/** Wrap a sink into a redaction-enforcing logger bound to a single run. */
export function createRunLogger(runId: string, sink: RunEventSink): RunLogger {
  const base = (
    type: RunEventInput["type"],
    level: NonNullable<RunEventInput["level"]>,
    message: string,
    extra?: Partial<RunEventInput>,
  ): Promise<void> =>
    sink.emit({
      runId,
      type,
      level,
      message: redact(message),
      data: extra?.data ? (redactDeep(extra.data) as Record<string, unknown>) : undefined,
      stage: extra?.stage,
    });

  return {
    stage: (stage, message) => base("stage", "info", message, { stage }),
    log: (message, data) => base("log", "info", message, { data }),
    warn: (message, data) => base("log", "warn", message, { data }),
    error: (message, data) => base("error", "error", message, { data }),
  };
}

/** Dev sink: prints to console (still redacted). seq is process-local only. */
export function createConsoleSink(): RunEventSink {
  let seq = 0;
  return {
    async emit(event) {
      // eslint-disable-next-line no-console
      console.log(
        `[run ${event.runId}] #${seq++} ${event.level} ${event.stage ?? event.type}: ${event.message}`,
      );
    },
  };
}

// TODO: createSseBroadcastSink() — in-process fan-out to connected web clients,
//       so the SSE endpoint can push instead of poll (post-dev optimization).
