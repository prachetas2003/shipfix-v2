import { describe, expect, it } from "vitest";
import { reconcileStuckRuns } from "../src/reconcileStuckRuns";

function fakeDb(
  stuckRows: Array<{ id: string; status: string }>,
  resourceRows: Array<{ status: string }>,
  eventRows: Array<{ stage: string | null; data: Record<string, unknown> | null }> = [],
) {
  let selectCount = 0;
  return {
    select() {
      selectCount++;
      const rows = selectCount === 1 ? stuckRows : selectCount === 2 ? eventRows : resourceRows;
      return {
        from() {
          return {
            where() {
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
  } as unknown as import("@shipfix/db").Database;
}

describe("reconcileStuckRuns", () => {
  it("leaves runs alone while their Temporal workflow is still running", async () => {
    const db = fakeDb(
      [{ id: "00000000-0000-0000-0000-000000000010", status: "planning", startedAt: new Date() } as never],
      [],
    );
    const summary = await reconcileStuckRuns(db, {
      dryRun: true,
      planTransitionOlderThanMs: 1,
      workflowLiveness: async () => "running",
    });
    expect(summary.examined).toBe(1);
    expect(summary.results).toEqual([]);
  });

  it("still reconciles runs whose workflow has closed or vanished", async () => {
    const db = fakeDb(
      [{ id: "00000000-0000-0000-0000-000000000011", status: "wiring", startedAt: new Date(0) } as never],
      [{ status: "live" }],
    );
    const summary = await reconcileStuckRuns(db, {
      dryRun: true,
      olderThanMs: 1,
      workflowLiveness: async () => "not_found",
    });
    expect(summary.results[0]).toMatchObject({ previousStatus: "wiring", newStatus: "diagnosed" });
  });

  it("reconciles a running workflow past the hard cap", async () => {
    const db = fakeDb(
      [{ id: "00000000-0000-0000-0000-000000000012", status: "deploying", startedAt: new Date(0) } as never],
      [],
    );
    const summary = await reconcileStuckRuns(db, {
      dryRun: true,
      olderThanMs: 1,
      maxRunMs: 1000,
      workflowLiveness: async () => "running",
    });
    expect(summary.results).toHaveLength(1);
  });

  it("treats awaiting_input as non-terminal and preserves live resources as diagnosed", async () => {
    const db = fakeDb(
      [{ id: "00000000-0000-0000-0000-000000000001", status: "awaiting_input" }],
      [{ status: "live" }],
    );

    const summary = await reconcileStuckRuns(db, { dryRun: true, olderThanMs: 1 });

    expect(summary.examined).toBe(1);
    expect(summary.results[0]).toMatchObject({
      previousStatus: "awaiting_input",
      newStatus: "diagnosed",
      liveResources: 1,
    });
  });

  it("classifies stuck validating runs as internal validation stalls", async () => {
    const db = fakeDb(
      [{ id: "00000000-0000-0000-0000-000000000002", status: "validating" }],
      [],
    );

    const summary = await reconcileStuckRuns(db, { dryRun: true, olderThanMs: 1 });

    expect(summary.results[0]).toMatchObject({
      previousStatus: "validating",
      newStatus: "failed",
      liveResources: 0,
    });
    expect(summary.results[0]?.reason).toContain("Plan validation stalled inside ShipFix");
  });

  it("marks old queued runs without workflow_started as workflow start missing", async () => {
    const db = fakeDb(
      [{ id: "00000000-0000-0000-0000-000000000003", status: "queued" }],
      [],
    );

    const summary = await reconcileStuckRuns(db, { dryRun: true, queuedOlderThanMs: 1 });

    expect(summary.results[0]).toMatchObject({
      previousStatus: "queued",
      newStatus: "failed",
      liveResources: 0,
    });
    expect(summary.results[0]?.reason).toContain("no Temporal workflow start was recorded");
  });

  it("marks old queued runs with workflow_started but no worker progress as worker not polling", async () => {
    const db = fakeDb(
      [{ id: "00000000-0000-0000-0000-000000000004", status: "queued" }],
      [],
      [{ stage: null, data: { event: "workflow_started" } }],
    );

    const summary = await reconcileStuckRuns(db, { dryRun: true, queuedOlderThanMs: 1 });

    expect(summary.results[0]).toMatchObject({
      previousStatus: "queued",
      newStatus: "diagnosed",
      liveResources: 0,
    });
    expect(summary.results[0]?.reason).toContain("worker did not pick it up");
  });

  it("marks analysis-completed runs with no planning event as an internal transition failure", async () => {
    const db = fakeDb(
      [{ id: "00000000-0000-0000-0000-000000000005", status: "analyzing" }],
      [],
      [{ stage: "analyzing", data: { event: "analysis_completed" } }],
    );

    const summary = await reconcileStuckRuns(db, { dryRun: true, planTransitionOlderThanMs: 1 });

    expect(summary.results[0]).toMatchObject({
      previousStatus: "analyzing",
      newStatus: "failed",
      liveResources: 0,
    });
    expect(summary.results[0]?.reason).toContain("did not enter plan generation");
  });

  it("marks planning runs with no plan result as an internal generation stall", async () => {
    const db = fakeDb(
      [{ id: "00000000-0000-0000-0000-000000000006", status: "planning" }],
      [],
      [
        { stage: "analyzing", data: { event: "analysis_completed" } },
        { stage: "planning", data: { event: "planning_started" } },
      ],
    );

    const summary = await reconcileStuckRuns(db, { dryRun: true, planTransitionOlderThanMs: 1 });

    expect(summary.results[0]).toMatchObject({
      previousStatus: "planning",
      newStatus: "failed",
      liveResources: 0,
    });
    expect(summary.results[0]?.reason).toContain("started plan generation");
  });
});
