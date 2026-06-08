import { describe, expect, it } from "vitest";
import { reconcileStuckRuns } from "../src/reconcileStuckRuns";

function fakeDb(stuckRows: Array<{ id: string; status: string }>, resourceRows: Array<{ status: string }>) {
  let selectCount = 0;
  return {
    select() {
      selectCount++;
      const rows = selectCount === 1 ? stuckRows : resourceRows;
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
});
