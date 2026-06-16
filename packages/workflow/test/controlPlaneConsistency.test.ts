import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_PLANE_CONSISTENCY_EVENT,
  ControlPlaneConsistencyError,
  controlPlaneConsistencyDetail,
  isControlPlaneConsistencyMessage,
} from "../src/controlPlaneConsistency";
import { failureEventForMessage } from "../src/errorMessages";

interface FakeRow {
  [key: string]: unknown;
}

const h = vi.hoisted(() => {
  const rows: Record<string, FakeRow[]> = { runs: [] };
  const events: Array<{ level: string; message: string; data: Record<string, unknown> }> = [];
  return { rows, events };
});

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ eq: [col, val] }),
}));

vi.mock("@shipfix/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shipfix/db")>();
  const table = (name: string): Record<string, unknown> =>
    new Proxy({ __table: name }, { get: (t, prop) => (prop === "__table" ? name : { table: name, column: prop }) });

  const runs = table("runs");
  const rowsFor = (t: { __table?: string }): FakeRow[] => h.rows[(t as { __table: string }).__table];

  type Cond = { eq?: [{ column: string }, unknown] } | undefined;
  const matches = (row: FakeRow, cond: Cond): boolean => {
    if (!cond?.eq) return true;
    return row[cond.eq[0].column] === cond.eq[1];
  };

  class Query implements PromiseLike<FakeRow[]> {
    private cond: Cond;
    constructor(private readonly table: { __table: string }) {}
    where(cond: Cond): this {
      this.cond = cond;
      return this;
    }
    limit(): this {
      return this;
    }
    then<T1, T2>(
      onfulfilled?: ((value: FakeRow[]) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): Promise<T1 | T2> {
      const result = rowsFor(this.table).filter((r) => matches(r, this.cond));
      return Promise.resolve(result).then(onfulfilled, onrejected);
    }
  }

  const db = {
    select: (..._cols: unknown[]) => ({ from: (t: { __table: string }) => new Query(t) }),
    update: (t: { __table: string }) => ({
      set: (vals: FakeRow) => ({
        where: (cond: Cond) => {
          const target = rowsFor(t).find((r) => matches(r, cond));
          if (target) Object.assign(target, vals);
          return Promise.resolve();
        },
      }),
    }),
  };

  return { ...actual, runs, createDb: () => db };
});

vi.mock("@shipfix/observability", () => {
  const push = (level: string) => (message: string, data: Record<string, unknown> = {}) => {
    h.events.push({ level, message, data });
    return Promise.resolve();
  };
  return {
    createRunLogger: () => ({
      log: push("info"),
      warn: push("warn"),
      error: push("error"),
      stage: (stage: string, message: string) => {
        h.events.push({ level: "info", message, data: { stage } });
        return Promise.resolve();
      },
    }),
    createSafePostgresSink: () => ({ emit: async () => {} }),
  };
});

describe("control plane consistency helpers", () => {
  it("classifies missing-run messages as internal consistency failures", () => {
    const runId = "af0c11c3-94a1-4b97-b415-7ea2801b3c78";
    expect(isControlPlaneConsistencyMessage(`Run ${runId} not found.`)).toBe(true);
    expect(failureEventForMessage(`Run ${runId} not found.`)).toMatchObject({
      event: CONTROL_PLANE_CONSISTENCY_EVENT,
    });
    expect(new ControlPlaneConsistencyError(runId, controlPlaneConsistencyDetail(runId)).code).toBe(
      CONTROL_PLANE_CONSISTENCY_EVENT,
    );
  });
});

describe("workflow activities — control plane consistency", () => {
  beforeEach(() => {
    h.rows.runs = [];
    h.events.length = 0;
    process.env.DATABASE_URL = "postgres://localhost:5432/shipfix";
  });

  it("loadRun missing row throws ControlPlaneConsistencyError", async () => {
    const { analyzeRepo } = await import("../src/activities");
    const runId = "33333333-3333-4333-8333-333333333333";
    await expect(analyzeRepo(runId)).rejects.toBeInstanceOf(ControlPlaneConsistencyError);
  });

  it("failRun marks an existing queued run failed instead of leaving it queued", async () => {
    const { failRun } = await import("../src/activities");
    const runId = "44444444-4444-4444-8444-444444444444";
    h.rows.runs.push({ id: runId, status: "queued" });

    await failRun(runId, new ControlPlaneConsistencyError(runId, controlPlaneConsistencyDetail(runId)).message);

    expect(h.rows.runs[0]?.status).toBe("failed");
    expect(h.rows.runs[0]?.finishedAt).toBeTruthy();
    expect(h.events.some((e) => e.data.event === CONTROL_PLANE_CONSISTENCY_EVENT)).toBe(true);
  });

  it("failRun logs worker-side mismatch when the run row is absent in worker DB", async () => {
    const { failRun } = await import("../src/activities");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runId = "55555555-5555-4555-8555-555555555555";

    await failRun(runId, `Run ${runId} not found.`);

    expect(h.rows.runs).toHaveLength(0);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
