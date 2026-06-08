import { afterEach, describe, expect, it } from "vitest";
import type { LLMGateway } from "@shipfix/llm";
import { meteredGateway } from "../src/activities";

function fakeDb(existingRunCalls = 0) {
  const inserted: Array<Record<string, unknown>> = [];
  let selectCount = 0;
  const db = {
    select() {
      selectCount++;
      const count = selectCount === 1 ? existingRunCalls : 0;
      return {
        from() {
          return {
            where() {
              return Promise.resolve([{ count }]);
            },
          };
        },
      };
    },
    insert() {
      return {
        values(row: Record<string, unknown>) {
          inserted.push(row);
          return Promise.resolve();
        },
      };
    },
  } as unknown as import("@shipfix/db").Database;
  return { db, inserted };
}

const gateway: LLMGateway = {
  model: "fake-model",
  async complete() {
    return { model: "fake-model", text: '{"ok":true}', usage: { inputTokens: 12, outputTokens: 4 } };
  },
};

describe("meteredGateway", () => {
  const OLD_ENV = process.env;
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("records successful LLM usage", async () => {
    process.env = { ...OLD_ENV, LLM_PROVIDER: "openai", ALPHA_MAX_LLM_CALLS_PER_RUN: "3" };
    const { db, inserted } = fakeDb();
    const metered = meteredGateway(gateway, db, {
      userId: "00000000-0000-0000-0000-000000000001",
      projectId: "00000000-0000-0000-0000-000000000002",
      runId: "00000000-0000-0000-0000-000000000003",
      operation: "plan",
    });

    await metered.complete({ system: "s", user: "u" });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      provider: "openai",
      model: "fake-model",
      operation: "plan",
      inputTokens: 12,
      outputTokens: 4,
      success: true,
    });
  });

  it("blocks calls above the per-run alpha limit and records the rejection", async () => {
    process.env = { ...OLD_ENV, LLM_PROVIDER: "openai", ALPHA_MAX_LLM_CALLS_PER_RUN: "1" };
    const { db, inserted } = fakeDb(1);
    const metered = meteredGateway(gateway, db, {
      userId: "00000000-0000-0000-0000-000000000001",
      projectId: "00000000-0000-0000-0000-000000000002",
      runId: "00000000-0000-0000-0000-000000000003",
      operation: "plan",
    });

    await expect(metered.complete({ system: "s", user: "u" })).rejects.toThrow(/alpha usage limit/i);
    expect(inserted[0]).toMatchObject({ success: false, error: "alpha_llm_limit" });
  });
});
