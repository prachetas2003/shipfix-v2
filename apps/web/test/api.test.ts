import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../app/lib/api";

describe("api client", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("starts deploy from an existing run with a valid empty JSON body", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ runId: "00000000-0000-0000-0000-000000000123" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(api.startDeployFromRun("00000000-0000-0000-0000-000000000001")).resolves.toBe(
      "00000000-0000-0000-0000-000000000123",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/runs/00000000-0000-0000-0000-000000000001/deploy",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: "{}",
      }),
    );
  });
});
