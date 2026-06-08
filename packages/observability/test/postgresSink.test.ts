import { describe, it, expect, vi } from "vitest";
import type { RunEventInput } from "@shipfix/contracts";
import {
  createNonFatalSink,
  createPostgresSink,
  isRunEventsSeqConflict,
} from "../src/postgresSink.js";

describe("isRunEventsSeqConflict", () => {
  it("detects Postgres 23505 on the run_events seq unique index", () => {
    expect(isRunEventsSeqConflict({ code: "23505" })).toBe(true);
    expect(isRunEventsSeqConflict({ cause: { code: "23505" } })).toBe(true);
    expect(
      isRunEventsSeqConflict(new Error('duplicate key value violates unique constraint "run_events_seq_unique"')),
    ).toBe(true);
  });
});

describe("createNonFatalSink", () => {
  it("does not throw when the inner sink fails", async () => {
    const inner = {
      async emit() {
        throw new Error("run_events_seq_unique");
      },
    };
    const sink = createNonFatalSink(inner);
    await expect(
      sink.emit({
        runId: "00000000-0000-0000-0000-000000000001",
        type: "log",
        level: "info",
        message: "terminal event",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("createPostgresSink serialization", () => {
  it("queues concurrent emits for the same run without overlapping", async () => {
    let maxConcurrent = 0;
    let inFlight = 0;
    const order: number[] = [];

    const db = {
      transaction: async (fn: (tx: { execute: () => Promise<void> }) => Promise<void>) => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        order.push(order.length);
        await new Promise((r) => setTimeout(r, 5));
        await fn({ execute: async () => {} });
        inFlight--;
      },
    } as unknown as import("@shipfix/db").Database;

    const sink = createPostgresSink(db);
    const base: RunEventInput = {
      runId: "00000000-0000-0000-0000-000000000099",
      type: "log",
      level: "info",
      message: "x",
    };

    await Promise.all([
      sink.emit({ ...base, message: "a" }),
      sink.emit({ ...base, message: "b" }),
      sink.emit({ ...base, message: "c" }),
    ]);

    expect(maxConcurrent).toBe(1);
    expect(order).toEqual([0, 1, 2]);
  });
});
