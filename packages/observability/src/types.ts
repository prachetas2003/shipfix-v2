import type { RunEventInput } from "@shipfix/contracts";

export interface RunEventSink {
  emit(event: RunEventInput): Promise<void>;
}

export interface RunLogger {
  stage(stage: RunEventInput["stage"], message: string): Promise<void>;
  log(message: string, data?: Record<string, unknown>): Promise<void>;
  warn(message: string, data?: Record<string, unknown>): Promise<void>;
  error(message: string, data?: Record<string, unknown>): Promise<void>;
}
