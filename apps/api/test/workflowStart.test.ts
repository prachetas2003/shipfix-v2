import { describe, expect, it, vi } from "vitest";
import {
  logWorkflowStarted,
  logWorkflowStarting,
  markWorkflowStartFailed,
  withTimeout,
  type WorkflowStartInfo,
} from "../src/workflowStart";

function fakeLogger() {
  const events: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
  return {
    events,
    logger: {
      log: async (message: string, data?: Record<string, unknown>) => {
        events.push({ level: "info", message, data });
      },
      warn: async (message: string, data?: Record<string, unknown>) => {
        events.push({ level: "warn", message, data });
      },
      error: async (message: string, data?: Record<string, unknown>) => {
        events.push({ level: "error", message, data });
      },
      stage: async (stage: string, message: string) => {
        events.push({ level: "info", message, data: { stage } });
      },
    },
  };
}

const info: WorkflowStartInfo = {
  workflowId: "run-11111111-1111-4111-8111-111111111111",
  taskQueue: "shipfix",
  temporalAddress: "localhost:7233",
  temporalNamespace: "default",
};

describe("workflow start logging", () => {
  it("writes workflow_starting and workflow_started events with safe metadata", async () => {
    const { logger, events } = fakeLogger();

    await logWorkflowStarting(logger, info);
    await logWorkflowStarted(logger, info);

    expect(events.map((e) => e.data?.event)).toEqual(["workflow_starting", "workflow_started"]);
    expect(events[1]?.data).toMatchObject({
      workflowId: info.workflowId,
      taskQueue: "shipfix",
      temporalAddress: "localhost:7233",
    });
    expect(JSON.stringify(events)).not.toContain("sk_");
  });

  it("workflow start failure marks the run failed and emits internal_workflow_start_failed", async () => {
    const { logger, events } = fakeLogger();
    const updates: Record<string, unknown>[] = [];
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            updates.push(values);
            return Promise.resolve();
          },
        }),
      }),
    };

    await markWorkflowStartFailed(
      db as never,
      logger,
      "11111111-1111-4111-8111-111111111111",
      info,
      new Error("Temporal is not reachable"),
    );

    expect(updates[0]).toMatchObject({ status: "failed" });
    expect(updates[0]?.finishedAt).toBeInstanceOf(Date);
    expect(events[0]?.data?.event).toBe("internal_workflow_start_failed");
    expect(events[0]?.message).toContain("could not start");
  });

  it("times out slow workflow-start operations", async () => {
    vi.useFakeTimers();
    const promise = withTimeout(new Promise(() => {}), 100, "too slow");
    const assertion = expect(promise).rejects.toThrow("too slow");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    vi.useRealTimers();
  });
});
