import type { FileEdit } from "../types";

const MAX_DIFF_LINES = 4000;

/** Minimal unified diff (3 lines of context) for PR bodies and copy-paste prompts. */
export function unifiedDiff(edit: FileEdit): string {
  const a = edit.before === null ? [] : edit.before.split("\n");
  const b = edit.after.split("\n");
  const header = `--- ${edit.before === null ? "/dev/null" : `a/${edit.path}`}\n+++ b/${edit.path}\n`;
  if (a.length + b.length > MAX_DIFF_LINES) {
    return `${header}@@ file too large for an inline diff (${a.length} → ${b.length} lines) @@\n`;
  }

  // LCS table, then walk it into a list of ops.
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  type Op = { t: " " | "-" | "+"; line: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ t: " ", line: a[i]!, ai: i++, bi: j++ });
    else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) ops.push({ t: "-", line: a[i]!, ai: i++, bi: j });
    else ops.push({ t: "+", line: b[j]!, ai: i, bi: j++ });
  }

  const CONTEXT = 3;
  const changed = ops.map((o, k) => (o.t !== " " ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return "";
  const hunks: Array<[number, number]> = [];
  for (const k of changed) {
    const start = Math.max(0, k - CONTEXT);
    const end = Math.min(ops.length - 1, k + CONTEXT);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1] + 1) last[1] = end;
    else hunks.push([start, end]);
  }

  let out = header;
  for (const [s, e] of hunks) {
    const slice = ops.slice(s, e + 1);
    const aLen = slice.filter((o) => o.t !== "+").length;
    const bLen = slice.filter((o) => o.t !== "-").length;
    out += `@@ -${slice[0]!.ai + (aLen ? 1 : 0)},${aLen} +${slice[0]!.bi + (bLen ? 1 : 0)},${bLen} @@\n`;
    out += slice.map((o) => `${o.t}${o.line}`).join("\n") + "\n";
  }
  return out;
}

export function unifiedDiffs(edits: FileEdit[]): string {
  return edits.map(unifiedDiff).join("\n");
}
