import { describe, expect, it } from "vitest";
import {
  billLines,
  capStanding,
  detectSpendSpike,
  measuredSpendCents,
  parseFocusCharges,
  parseRenderBandwidth,
  runCostCents,
  suggestCheaperMove,
  usageSpike,
} from "../src/index";

describe("guardian bills", () => {
  it("rounds a run's model estimates into cents", () => {
    expect(runCostCents([0.4, 0.4])).toBe(1);
    expect(runCostCents([0.2])).toBe(0);
    expect(runCostCents([])).toBe(0);
  });

  it("counts a cap only from numbers that were actually read", () => {
    expect(measuredSpendCents(40, [120, null])).toBe(160);
    expect(capStanding(160, 100).over).toBe(true);
    expect(capStanding(40, null)).toMatchObject({ over: false, remainingCents: null });
  });

  it("adds USD charges from a Vercel bill and leaves other currencies out", () => {
    const read = parseFocusCharges(
      [
        JSON.stringify({ BilledCost: "1.20", BillingCurrency: "USD", ServiceName: "Fast Data Transfer", ConsumedUnit: "bytes", ConsumedQuantity: "1000", SkuId: "bandwidth" }),
        JSON.stringify({ BilledCost: "9", BillingCurrency: "EUR" }),
      ].join("\n"),
    );
    expect(read.billedCents).toBe(120);
    expect(read.traffic).toBe(1000);
    expect(read.note).toContain("EUR");
    expect(parseFocusCharges("")).toMatchObject({ billedCents: 0 });
    expect(parseFocusCharges("{")).toMatchObject({ billedCents: null });
  });

  it("sums Render bandwidth without turning it into a price", () => {
    const read = parseRenderBandwidth([
      { unit: "GB", values: [{ value: 1.5 }, { value: 0.5 }] },
    ]);
    expect(read.billedCents).toBeNull();
    expect(read.traffic).toBe(2);
    expect(read.note).toContain("does not return an invoice");
    expect(parseRenderBandwidth([{ unit: "GB", values: [{ value: 1 }] }, { unit: "MB", values: [{ value: 1 }] }]).traffic).toBeNull();
  });

  it("flags a jump and ignores a start from zero", () => {
    expect(usageSpike(500, 100, 5, 100)).toBe(true);
    expect(usageSpike(10, 0)).toBe(false);
    expect(
      detectSpendSpike(
        { billedCents: 500, traffic: null, trafficUnit: null, note: "" },
        { billedCents: 100, traffic: null, trafficUnit: null, note: "" },
      ),
    ).toBe(true);
    expect(
      detectSpendSpike(
        { billedCents: null, traffic: 6, trafficUnit: "GB", note: "" },
        { billedCents: null, traffic: 1, trafficUnit: "GB", note: "" },
      ),
    ).toBe(true);
    expect(
      detectSpendSpike(
        { billedCents: null, traffic: 50, trafficUnit: "bytes", note: "" },
        { billedCents: null, traffic: 10, trafficUnit: "bytes", note: "" },
      ),
    ).toBe(false);
  });

  it("offers a cheaper host only when both prices are for the same service", () => {
    expect(
      suggestCheaperMove(
        [{ id: "web", type: "frontend_static", provider: "vercel" }],
        [
          { provider: "vercel", supports: ["frontend_static"], serviceCents: 500 },
          { provider: "render", supports: ["node_api"], serviceCents: 0 },
        ],
      ),
    ).toBeNull();
    expect(
      suggestCheaperMove(
        [{ id: "web", type: "frontend_static", provider: "vercel" }],
        [
          { provider: "vercel", supports: ["frontend_static"], serviceCents: null },
          { provider: "pages", supports: ["frontend_static"], serviceCents: 0 },
        ],
      ),
    ).toBeNull();
    expect(
      suggestCheaperMove(
        [{ id: "web", type: "frontend_static", provider: "vercel" }],
        [
          { provider: "vercel", supports: ["frontend_static"], serviceCents: 500 },
          { provider: "pages", supports: ["frontend_static"], serviceCents: 0 },
        ],
      ),
    ).toEqual({ serviceId: "web", from: "vercel", to: "pages" });
  });

  it("names what was measured and what was not", () => {
    const lines = billLines({
      shipfixCents: 4,
      cap: capStanding(4, null),
      vercel: null,
      render: { billedCents: null, traffic: 2, trafficUnit: "GB", note: "Render does not return an invoice through this API." },
      unread: ["Neon can return usage units on a paid plan. ShipFix does not turn those units into a dollar bill."],
      spike: false,
    });
    expect(lines[0]).toContain("$0.04");
    expect(lines.some((line) => line.includes("Vercel is not connected"))).toBe(true);
    expect(lines.some((line) => line.includes("2 GB"))).toBe(true);
    expect(lines.some((line) => line.includes("one-click move stays off"))).toBe(true);
  });
});
