/**
 * Spend math for Guardian. Dollar amounts come only from a provider response
 * that named a USD charge, or from ShipFix's own model estimates. Usage units
 * are not converted into a price.
 */

export interface MoneyRead {
  billedCents: number | null;
  traffic: number | null;
  trafficUnit: string | null;
  note: string;
}

export interface MoveService {
  id: string;
  type: string;
  provider: string;
}

export interface MoveHost {
  provider: string;
  supports: readonly string[];
  /** A bill for one service. An account total must stay null. */
  serviceCents: number | null;
}

export interface CapStanding {
  capCents: number | null;
  spentCents: number;
  over: boolean;
  remainingCents: number | null;
}

const BANDWIDTH = /bandwidth|data transfer|fast data transfer/i;

/** Integer cents from model-cost estimates. Missing and non-finite values count as zero. */
export function runCostCents(estimates: number[]): number {
  const sum = estimates.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
  return Math.max(0, Math.round(sum));
}

export function measuredSpendCents(shipfixCents: number, providerBilledCents: Array<number | null>): number {
  const extra = providerBilledCents.reduce<number>((total, value) => total + (value ?? 0), 0);
  return Math.max(0, shipfixCents) + extra;
}

export function capStanding(spentCents: number, capCents: number | null): CapStanding {
  if (capCents == null) {
    return { capCents: null, spentCents, over: false, remainingCents: null };
  }
  return {
    capCents,
    spentCents,
    over: spentCents > capCents,
    remainingCents: capCents - spentCents,
  };
}

function money(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** FOCUS JSONL from Vercel's billing charges endpoint. Costs are USD, not invented. */
export function parseFocusCharges(body: string): MoneyRead {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { billedCents: 0, traffic: null, trafficUnit: null, note: "Vercel returned no charges for this period." };
  }
  let dollars = 0;
  let sawUsd = false;
  let otherCurrency: string | null = null;
  let traffic = 0;
  let trafficUnit: string | null = null;
  let sawTraffic = false;
  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") {
        return { billedCents: null, traffic: null, trafficUnit: null, note: "Vercel returned a bill ShipFix could not read." };
      }
      row = parsed as Record<string, unknown>;
    } catch {
      return { billedCents: null, traffic: null, trafficUnit: null, note: "Vercel returned a bill ShipFix could not read." };
    }
    const currency = typeof row.BillingCurrency === "string" ? row.BillingCurrency.toUpperCase() : "USD";
    const cost = money(row.BilledCost);
    if (currency !== "USD") {
      otherCurrency = currency;
      continue;
    }
    if (cost == null) {
      return { billedCents: null, traffic: null, trafficUnit: null, note: "Vercel returned a charge without a dollar amount." };
    }
    sawUsd = true;
    dollars += cost;
    const name = `${typeof row.ServiceName === "string" ? row.ServiceName : ""} ${typeof row.SkuId === "string" ? row.SkuId : ""}`;
    const unit = typeof row.ConsumedUnit === "string" ? row.ConsumedUnit : "";
    const quantity = money(row.ConsumedQuantity);
    if (BANDWIDTH.test(name) && /byte/i.test(unit) && quantity != null) {
      sawTraffic = true;
      traffic += quantity;
      trafficUnit = unit;
    }
  }
  if (!sawUsd) {
    return {
      billedCents: null,
      traffic: sawTraffic ? traffic : null,
      trafficUnit: sawTraffic ? trafficUnit : null,
      note: otherCurrency
        ? `Vercel billed in ${otherCurrency}. ShipFix only adds USD charges.`
        : "Vercel returned charges without a USD amount.",
    };
  }
  return {
    billedCents: Math.round(dollars * 100),
    traffic: sawTraffic ? traffic : null,
    trafficUnit: sawTraffic ? trafficUnit : null,
    note: otherCurrency
      ? `Vercel account charges for this period, in USD. A ${otherCurrency} charge was left out.`
      : "Vercel account charges for this period.",
  };
}

/** Render bandwidth series. The API does not include a price. */
export function parseRenderBandwidth(body: unknown): MoneyRead {
  if (!Array.isArray(body)) {
    return {
      billedCents: null,
      traffic: null,
      trafficUnit: null,
      note: "Render returned bandwidth ShipFix could not read. Render does not return an invoice through this API.",
    };
  }
  if (body.length === 0) {
    return {
      billedCents: null,
      traffic: 0,
      trafficUnit: null,
      note: "Render returned no bandwidth for this period. Render does not return an invoice through this API.",
    };
  }
  let traffic = 0;
  let unit: string | null = null;
  for (const series of body) {
    if (!series || typeof series !== "object") {
      return {
        billedCents: null,
        traffic: null,
        trafficUnit: null,
        note: "Render returned bandwidth ShipFix could not read. Render does not return an invoice through this API.",
      };
    }
    const row = series as { unit?: unknown; values?: unknown };
    const nextUnit = typeof row.unit === "string" ? row.unit : null;
    if (unit && nextUnit && unit !== nextUnit) {
      return {
        billedCents: null,
        traffic: null,
        trafficUnit: null,
        note: "Render returned bandwidth in more than one unit. Render does not return an invoice through this API.",
      };
    }
    unit = unit ?? nextUnit;
    if (!Array.isArray(row.values)) {
      return {
        billedCents: null,
        traffic: null,
        trafficUnit: null,
        note: "Render returned bandwidth ShipFix could not read. Render does not return an invoice through this API.",
      };
    }
    for (const point of row.values) {
      const value = point && typeof point === "object" ? money((point as { value?: unknown }).value) : null;
      if (value == null) {
        return {
          billedCents: null,
          traffic: null,
          trafficUnit: null,
          note: "Render returned a bandwidth point without a number. Render does not return an invoice through this API.",
        };
      }
      traffic += value;
    }
  }
  return {
    billedCents: null,
    traffic,
    trafficUnit: unit,
    note: unit
      ? `Render bandwidth for this app's services, in ${unit}. Render does not return an invoice through this API.`
      : "Render bandwidth for this app's services. The unit was not named. Render does not return an invoice through this API.",
  };
}

export function httpSpendNote(provider: string, status: number | null): string | null {
  if (status == null) return null;
  if (status === 0) return `${provider} could not be reached.`;
  if (status < 200 || status >= 300) return `${provider} did not return usage (HTTP ${status}).`;
  return null;
}

export function trafficFloor(unit: string | null): number | null {
  if (!unit) return null;
  if (/gb/i.test(unit)) return 1;
  if (/mb/i.test(unit)) return 100;
  if (/byte/i.test(unit)) return 100_000_000;
  return null;
}

/** A jump against the previous window. A zero baseline is not a spike. */
export function usageSpike(current: number | null, previous: number | null, ratio = 5, floor = 1): boolean {
  if (current == null || previous == null) return false;
  if (!(previous >= floor)) return false;
  return current >= previous * ratio;
}

export function detectSpendSpike(recent: MoneyRead, previous: MoneyRead): boolean {
  if (usageSpike(recent.billedCents, previous.billedCents, 5, 100)) return true;
  const floor = trafficFloor(recent.trafficUnit ?? previous.trafficUnit);
  if (floor == null) return false;
  return usageSpike(recent.traffic, previous.traffic, 5, floor);
}

/**
 * A move is offered only when two hosts can run the same service and both
 * returned a price for that service. Account totals are not a reason to move.
 */
export function suggestCheaperMove(
  services: MoveService[],
  hosts: MoveHost[],
): { serviceId: string; from: string; to: string } | null {
  for (const service of services) {
    const current = hosts.find((host) => host.provider === service.provider);
    if (!current || current.serviceCents == null) continue;
    const cheaper = hosts
      .filter(
        (host) =>
          host.provider !== service.provider &&
          host.supports.includes(service.type) &&
          host.serviceCents != null &&
          (host.serviceCents as number) < (current.serviceCents as number),
      )
      .sort((a, b) => (a.serviceCents as number) - (b.serviceCents as number))[0];
    if (cheaper) return { serviceId: service.id, from: service.provider, to: cheaper.provider };
  }
  return null;
}

export const NO_MOVE_NOTE =
  "A one-click move stays off. Vercel charges are for the whole account, Render returns bandwidth rather than a price, and ShipFix cannot run a frontend on the server host.";

export const UNREADABLE_PROVIDER_NOTES: Record<string, string> = {
  neon: "Neon can return usage units on a paid plan. ShipFix does not turn those units into a dollar bill.",
  supabase: "Supabase usage is not read. The connection is not used as an invoice API.",
  upstash: "Upstash usage is not read. The connection is not used as an invoice API.",
};

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

export function billLines(input: {
  shipfixCents: number;
  cap: CapStanding;
  vercel: MoneyRead | null;
  render: MoneyRead | null;
  unread: string[];
  spike: boolean;
}): string[] {
  const lines = [`ShipFix model estimates this month: ${formatCents(input.shipfixCents)}.`];
  if (input.cap.capCents == null) {
    lines.push("No spend cap is set. The cap covers this month's model estimates plus any USD account charges that were read.");
  } else if (input.cap.over) {
    lines.push(
      `Spend cap ${formatCents(input.cap.capCents)} is passed. Counted so far: ${formatCents(input.cap.spentCents)}.`,
    );
  } else {
    lines.push(
      `Spend cap ${formatCents(input.cap.capCents)}. Counted so far: ${formatCents(input.cap.spentCents)}. Room left: ${formatCents(input.cap.remainingCents ?? 0)}.`,
    );
  }
  if (input.vercel) {
    const amount = input.vercel.billedCents == null ? "no USD total" : formatCents(input.vercel.billedCents);
    lines.push(`Vercel, last 7 days: ${amount}. ${input.vercel.note}`);
  } else {
    lines.push("Vercel is not connected, so its bill was not read.");
  }
  if (input.render) {
    const quantity =
      input.render.traffic == null
        ? "no bandwidth total"
        : `${input.render.traffic}${input.render.trafficUnit ? ` ${input.render.trafficUnit}` : ""}`;
    lines.push(`Render, last 7 days: ${quantity}. ${input.render.note}`);
  } else {
    lines.push("Render is not connected, so its bandwidth was not read.");
  }
  for (const note of input.unread) lines.push(note);
  if (input.spike) {
    lines.push(
      "Usage jumped compared with the previous week. That can be traffic, a bot, or a flood. ShipFix cannot tell those apart from these totals.",
    );
  }
  lines.push(NO_MOVE_NOTE);
  return lines;
}

export function billAlertText(repo: string, input: { over: boolean; spike: boolean; lines: string[] }): string {
  const why = [input.over ? "the spend cap is passed" : null, input.spike ? "usage jumped" : null].filter(Boolean).join(" and ");
  return `${repo}: ${why}.\n${input.lines.join("\n")}`;
}
