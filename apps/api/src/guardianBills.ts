import {
  billAlertText,
  billLines,
  capStanding,
  detectSpendSpike,
  httpSpendNote,
  measuredSpendCents,
  parseFocusCharges,
  parseRenderBandwidth,
  suggestCheaperMove,
  UNREADABLE_PROVIDER_NOTES,
  type MoneyRead,
  type MoveService,
} from "@shipfix/guardian";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function readBody(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: string | null }> {
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    const body = await res.text();
    return res.ok ? { status: res.status, body } : { status: res.status, body: null };
  } catch {
    return { status: 0, body: null };
  }
}

function declined(provider: string, status: number, body: string | null, parse: (text: string) => MoneyRead): MoneyRead {
  const note = httpSpendNote(provider, status);
  if (note || body == null) {
    return { billedCents: null, traffic: null, trafficUnit: null, note: note ?? `${provider} returned an empty response.` };
  }
  return parse(body);
}

function vercelUrl(from: Date, to: Date, teamId?: string): string {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (teamId) params.set("teamId", teamId);
  return `https://api.vercel.com/v1/billing/charges?${params}`;
}

function renderUrl(from: Date, to: Date, serviceIds: string[]): string {
  const params = new URLSearchParams({ startTime: from.toISOString(), endTime: to.toISOString() });
  for (const id of serviceIds) params.append("resource", id);
  return `https://api.render.com/v1/metrics/bandwidth?${params}`;
}

export async function readGuardianBills(input: {
  shipfixCents: number;
  capCents: number | null;
  connected: string[];
  vercel: { token: string; teamId?: string } | null;
  render: { token: string; serviceIds: string[] } | null;
  vercelBlocked?: string | null;
  renderBlocked?: string | null;
  services: MoveService[];
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<{
  lines: string[];
  spike: boolean;
  over: boolean;
  capCents: number | null;
  spentCents: number;
  remainingCents: number | null;
  alertText: (repo: string) => string;
}> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();
  const recentFrom = new Date(now.getTime() - WEEK_MS);
  const previousFrom = new Date(now.getTime() - 2 * WEEK_MS);

  let vercelRecent: MoneyRead | null = null;
  let vercelPrevious: MoneyRead | null = null;
  if (input.vercelBlocked) {
    vercelRecent = { billedCents: null, traffic: null, trafficUnit: null, note: input.vercelBlocked };
  } else if (input.vercel?.token) {
    const recent = await readBody(vercelUrl(recentFrom, now, input.vercel.teamId), input.vercel.token, fetchImpl);
    const previous = await readBody(vercelUrl(previousFrom, recentFrom, input.vercel.teamId), input.vercel.token, fetchImpl);
    vercelRecent = declined("Vercel", recent.status, recent.body, parseFocusCharges);
    vercelPrevious = declined("Vercel", previous.status, previous.body, parseFocusCharges);
  }

  let renderRecent: MoneyRead | null = null;
  let renderPrevious: MoneyRead | null = null;
  if (input.renderBlocked) {
    renderRecent = { billedCents: null, traffic: null, trafficUnit: null, note: input.renderBlocked };
  } else if (input.render?.token) {
    if (input.render.serviceIds.length === 0) {
      const note = "No Render service is recorded for this app, so bandwidth was not requested. Render does not return an invoice through this API.";
      renderRecent = { billedCents: null, traffic: null, trafficUnit: null, note };
    } else {
      const parse = (text: string): MoneyRead => {
        try {
          return parseRenderBandwidth(JSON.parse(text) as unknown);
        } catch {
          return {
            billedCents: null,
            traffic: null,
            trafficUnit: null,
            note: "Render returned bandwidth ShipFix could not read. Render does not return an invoice through this API.",
          };
        }
      };
      const recent = await readBody(renderUrl(recentFrom, now, input.render.serviceIds), input.render.token, fetchImpl);
      const previous = await readBody(renderUrl(previousFrom, recentFrom, input.render.serviceIds), input.render.token, fetchImpl);
      renderRecent = declined("Render", recent.status, recent.body, parse);
      renderPrevious = declined("Render", previous.status, previous.body, parse);
    }
  }

  const unread = input.connected
    .filter((provider) => provider in UNREADABLE_PROVIDER_NOTES)
    .map((provider) => UNREADABLE_PROVIDER_NOTES[provider] as string);
  const spike =
    (vercelRecent && vercelPrevious ? detectSpendSpike(vercelRecent, vercelPrevious) : false) ||
    (renderRecent && renderPrevious ? detectSpendSpike(renderRecent, renderPrevious) : false);
  const spentCents = measuredSpendCents(input.shipfixCents, [vercelRecent?.billedCents ?? null]);
  const cap = capStanding(spentCents, input.capCents);
  const move = suggestCheaperMove(input.services, [
    { provider: "vercel", supports: ["frontend_static", "frontend_ssr"], serviceCents: null },
    { provider: "render", supports: ["node_api", "python_api", "docker_service", "worker"], serviceCents: null },
  ]);
  const lines = billLines({
    shipfixCents: input.shipfixCents,
    cap,
    vercel: vercelRecent,
    render: renderRecent,
    unread,
    spike,
  });
  if (move) {
    lines.push(
      `${move.serviceId} would cost less on ${move.to} than on ${move.from}. ShipFix has not started that move.`,
    );
  }
  return {
    lines,
    spike,
    over: cap.over,
    capCents: cap.capCents,
    spentCents: cap.spentCents,
    remainingCents: cap.remainingCents,
    alertText: (repo) => billAlertText(repo, { over: cap.over, spike, lines }),
  };
}
