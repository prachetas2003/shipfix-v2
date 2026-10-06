import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PlanClassification } from "@shipfix/contracts";

/**
 * One repository in the eval corpus. Either a public GitHub repo (`repo`) or a
 * local directory (`path`, resolved relative to the corpus file) so CI can run
 * an offline slice against checked-in fixtures.
 */
export const CorpusEntry = z
  .object({
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, "repo must be 'owner/name'")
      .optional(),
    path: z.string().optional(),
    /** Stable report id; defaults to `repo` or `local:<dir name>`. */
    name: z.string().optional(),
    ref: z.string().optional(),
    /** Where the app came from: lovable | bolt | v0 | cursor | starter | oss | fixture ... */
    category: z.string().default("uncategorized"),
    /** How the entry was added (curated, discover:<query>). */
    source: z.string().default("curated"),
    /** Classification a human verified this repo SHOULD get. Drives regression checks. */
    expect: PlanClassification.optional(),
    notes: z.string().optional(),
  })
  .refine((e) => Boolean(e.repo) !== Boolean(e.path), {
    message: "exactly one of 'repo' or 'path' is required",
  });
export type CorpusEntry = z.infer<typeof CorpusEntry>;

export const Corpus = z.object({
  version: z.literal(1),
  entries: z.array(CorpusEntry),
  /** Repos pruned as non-apps; discovery never re-adds them. */
  excluded: z.array(z.string()).default([]),
});
export type Corpus = z.infer<typeof Corpus>;

export function entryId(entry: CorpusEntry): string {
  return entry.name ?? entry.repo ?? `local:${path.basename(entry.path ?? "")}`;
}

/** Parse and validate a corpus file; local paths become absolute. */
export async function loadCorpus(file: string): Promise<Corpus> {
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  const corpus = Corpus.parse(raw);
  const base = path.dirname(path.resolve(file));
  const seen = new Set<string>();
  const entries: CorpusEntry[] = [];
  for (const entry of corpus.entries) {
    const id = entryId(entry).toLowerCase();
    const resolved = entry.path
      ? { ...entry, name: entryId(entry), path: path.resolve(base, entry.path) }
      : entry;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(resolved);
  }
  return { version: 1, entries, excluded: corpus.excluded };
}

/** Merge new entries into a corpus, skipping repos already present or excluded (case-insensitive). */
export function mergeCorpus(corpus: Corpus, additions: CorpusEntry[]): { corpus: Corpus; added: number } {
  const seen = new Set([
    ...corpus.entries.map((e) => entryId(e).toLowerCase()),
    ...corpus.excluded.map((id) => id.toLowerCase()),
  ]);
  const entries = [...corpus.entries];
  let added = 0;
  for (const entry of additions) {
    const id = entryId(entry).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(entry);
    added++;
  }
  return { corpus: { version: 1, entries, excluded: corpus.excluded }, added };
}

/**
 * Drop discovered repos that a report shows are not apps (analyzed fine, zero
 * services — awesome-lists, profile READMEs, prompt collections). Curated
 * entries are never pruned; they are deliberate, including negatives.
 */
export function pruneNonApps(
  corpus: Corpus,
  results: readonly { id: string; status: string; shape?: { services: unknown[] } }[],
): { corpus: Corpus; removed: string[] } {
  const nonApps = new Set(
    results
      .filter((r) => r.status === "ok" && r.shape && r.shape.services.length === 0)
      .map((r) => r.id.toLowerCase()),
  );
  const removed: string[] = [];
  const entries = corpus.entries.filter((e) => {
    const drop = e.source.startsWith("discover:") && nonApps.has(entryId(e).toLowerCase());
    if (drop) removed.push(entryId(e));
    return !drop;
  });
  const excluded = [...new Set([...corpus.excluded, ...removed])].sort();
  return { corpus: { version: 1, entries, excluded }, removed };
}
