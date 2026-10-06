import type { CorpusEntry } from "./corpus";

/**
 * GitHub repository searches that surface apps exported from AI builders —
 * the users ShipFix exists for. Each query maps to a corpus category.
 */
export const DISCOVERY_QUERIES: { category: string; q: string }[] = [
  { category: "lovable", q: '"Welcome to your Lovable project" in:readme' },
  { category: "lovable", q: '"lovable.dev" in:readme' },
  { category: "bolt", q: '"bolt.new" in:readme' },
  { category: "bolt", q: "topic:bolt-new" },
  { category: "v0", q: '"v0.dev" in:readme' },
  { category: "v0", q: '"v0.app" in:readme' },
  { category: "vibe", q: "topic:vibe-coding" },
  { category: "vibe", q: '"built with cursor" in:readme' },
  { category: "replit", q: '"replit agent" in:readme' },
];

const BASE_FILTERS = "fork:false archived:false size:<200000";

export interface DiscoverOptions {
  token?: string;
  /** Max repos per query (GitHub caps search results at 1000). */
  perQuery?: number;
  /** Only repos pushed on/after this date (YYYY-MM-DD). */
  pushedSince?: string;
  fetchImpl?: typeof fetch;
  /** Delay between search pages; unauthenticated search allows ~10 req/min. */
  pageDelayMs?: number;
}

interface SearchResponse {
  total_count: number;
  items: { full_name: string; default_branch: string; fork: boolean; archived: boolean }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function discoverRepos(opts: DiscoverOptions = {}): Promise<CorpusEntry[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const perQuery = Math.min(opts.perQuery ?? 60, 1000);
  const pageDelayMs = opts.pageDelayMs ?? (opts.token ? 2_500 : 7_000);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "shipfix-eval",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const found = new Map<string, CorpusEntry>();
  let firstRequest = true;
  for (const { category, q } of DISCOVERY_QUERIES) {
    const query = [q, BASE_FILTERS, opts.pushedSince ? `pushed:>=${opts.pushedSince}` : ""]
      .filter(Boolean)
      .join(" ");
    let collected = 0;
    for (let page = 1; collected < perQuery && page <= 10; page++) {
      if (!firstRequest) await sleep(pageDelayMs);
      firstRequest = false;
      const perPage = Math.min(100, perQuery - collected);
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${perPage}&page=${page}`;
      const res = await fetchImpl(url, { headers });
      if (!res.ok) {
        throw new Error(`GitHub search failed (${res.status}) for query "${q}": ${(await res.text()).slice(0, 200)}`);
      }
      const body = (await res.json()) as SearchResponse;
      for (const item of body.items) {
        if (item.fork || item.archived) continue;
        const key = item.full_name.toLowerCase();
        if (!found.has(key)) {
          found.set(key, { repo: item.full_name, category, source: `discover:${q}` });
        }
        collected++;
      }
      if (body.items.length < perPage) break;
    }
  }
  return [...found.values()];
}
