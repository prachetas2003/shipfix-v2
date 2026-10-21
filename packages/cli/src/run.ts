const DEFAULT_API = "http://localhost:4000";
const POLL_MS = 3_000;
const WAIT_MS = 20 * 60 * 1000;

export interface ShipfixIo {
  argv: string[];
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  write: (line: string) => void;
  writeErr: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Snapshot {
  run?: { id?: string; status?: string; repoFullName?: string | null; branch?: string | null };
  plan?: { classification?: string; questions?: Array<{ id?: string; prompt?: string }> } | null;
  resources?: Array<{ serviceId?: string; url?: string | null; status?: string; role?: string }>;
  answeredQuestionIds?: string[];
}

function help(): string {
  return [
    "shipfix deploy [owner/repo] [--branch name] [--wait]",
    "shipfix status <runId>",
    "shipfix logs <runId> [--limit n]",
    "shipfix fix <runId>",
    "",
    "Auth: SHIPFIX_DEV_USER, or SHIPFIX_TOKEN. API: SHIPFIX_API_URL (default http://localhost:4000).",
    "A GitHub Action sets GITHUB_REPOSITORY when no repo argument is passed.",
  ].join("\n");
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function positionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--branch" || arg === "--limit") {
      i++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    out.push(arg);
  }
  return out;
}

export function summarizeRun(value: unknown): string {
  const snapshot: Snapshot = value && typeof value === "object" ? (value as Snapshot) : {};
  const run = snapshot.run ?? {};
  const answered = new Set(snapshot.answeredQuestionIds ?? []);
  const questions = (snapshot.plan?.questions ?? [])
    .filter((q) => q.id && q.prompt && !answered.has(q.id))
    .map((q) => q.prompt);
  const urls = (snapshot.resources ?? []).filter((r) => r.url).map((r) => `${r.role ?? r.serviceId}: ${r.url} (${r.status})`);
  return [
    `Run ${run.id ?? "unknown"} is ${run.status ?? "unknown"}.`,
    run.repoFullName ? `Repo: ${run.repoFullName}${run.branch ? ` (${run.branch})` : ""}` : "",
    snapshot.plan?.classification ? `Plan: ${snapshot.plan.classification}` : "",
    urls.length ? `Live:\n${urls.map((u) => `- ${u}`).join("\n")}` : "",
    questions.length ? `Waiting for answers:\n${questions.map((q) => `- ${q}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function request(
  io: ShipfixIo,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  const base = (io.env.SHIPFIX_API_URL || DEFAULT_API).replace(/\/$/, "");
  const headers = new Headers(init.headers);
  if (io.env.SHIPFIX_DEV_USER) headers.set("x-shipfix-dev-user", io.env.SHIPFIX_DEV_USER);
  else if (io.env.SHIPFIX_TOKEN) headers.set("authorization", `Bearer ${io.env.SHIPFIX_TOKEN}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await io.fetchImpl(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : `ShipFix API returned ${res.status}`;
    return { ok: false, message };
  }
  return { ok: true, body };
}

function authError(io: ShipfixIo): string | null {
  if (io.env.SHIPFIX_DEV_USER || io.env.SHIPFIX_TOKEN) return null;
  return "Set SHIPFIX_TOKEN, or SHIPFIX_DEV_USER when the API is in dev auth.";
}

function repoFrom(argv: string[], env: ShipfixIo["env"]): string | null {
  return positionals(argv)[1] || env.SHIPFIX_REPO || env.GITHUB_REPOSITORY || null;
}

function deployBody(repo: string, branch?: string): Record<string, string> {
  const body: Record<string, string> = repo.includes("github.com") ? { repoUrl: repo } : { repoFullName: repo };
  if (branch) body.branch = branch;
  return body;
}

async function waitFor(io: ShipfixIo, runId: string): Promise<number> {
  const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = io.now ?? Date.now;
  const started = now();
  for (;;) {
    const result = await request(io, `/runs/${runId}`);
    if (!result.ok) {
      io.writeErr(result.message);
      return 1;
    }
    const snapshot = result.body as Snapshot;
    const status = snapshot.run?.status;
    io.write(summarizeRun(result.body));
    if (status === "succeeded") return 0;
    if (status === "awaiting_input") return 2;
    if (status === "failed" || status === "diagnosed" || status === "cancelled") return 1;
    if (now() - started >= WAIT_MS) {
      io.writeErr("Timed out waiting for the deploy.");
      return 1;
    }
    await sleep(POLL_MS);
  }
}

export async function runShipfix(io: ShipfixIo): Promise<number> {
  const [command] = positionals(io.argv);
  if (!command || command === "help" || hasFlag(io.argv, "--help") || hasFlag(io.argv, "-h")) {
    io.write(help());
    return command || hasFlag(io.argv, "--help") || hasFlag(io.argv, "-h") ? 0 : 1;
  }
  const auth = authError(io);
  if (auth) {
    io.writeErr(auth);
    return 1;
  }

  if (command === "deploy") {
    const repo = repoFrom(io.argv, io.env);
    if (!repo) {
      io.writeErr("Pass owner/repo, or set SHIPFIX_REPO.");
      return 1;
    }
    const branch = flag(io.argv, "--branch") || io.env.SHIPFIX_BRANCH || undefined;
    const result = await request(io, "/runs/deploy", {
      method: "POST",
      body: JSON.stringify(deployBody(repo, branch)),
    });
    if (!result.ok) {
      io.writeErr(result.message);
      return 1;
    }
    const runId = (result.body as { runId?: string }).runId ?? "unknown";
    io.write(`Deploy started.\nrunId: ${runId}\nrepo: ${repo}`);
    const wait = hasFlag(io.argv, "--wait") || io.env.SHIPFIX_WAIT === "true";
    if (!wait) return 0;
    return waitFor(io, runId);
  }

  const runId = positionals(io.argv)[1];
  if (!runId) {
    io.writeErr(`Pass a run id. ${help()}`);
    return 1;
  }

  if (command === "status") {
    const result = await request(io, `/runs/${runId}`);
    if (!result.ok) {
      io.writeErr(result.message);
      return 1;
    }
    io.write(summarizeRun(result.body));
    return 0;
  }

  if (command === "logs") {
    const limit = flag(io.argv, "--limit") ?? "80";
    const result = await request(io, `/runs/${runId}/logs?limit=${encodeURIComponent(limit)}`);
    if (!result.ok) {
      io.writeErr(result.message);
      return 1;
    }
    const lines = (result.body as { lines?: Array<{ level?: string; message?: string }> }).lines ?? [];
    io.write(lines.length ? lines.map((l) => `[${l.level}] ${l.message}`).join("\n") : "No log lines yet.");
    return 0;
  }

  if (command === "fix") {
    const current = await request(io, `/runs/${runId}`);
    if (!current.ok) {
      io.writeErr(current.message);
      return 1;
    }
    const snapshot = current.body as Snapshot;
    const status = snapshot.run?.status;
    if (status === "awaiting_input") {
      io.write(summarizeRun(current.body));
      return 2;
    }
    if (status === "succeeded") {
      io.write("This deploy already succeeded. Nothing to fix.");
      return 0;
    }
    if (status !== "failed" && status !== "diagnosed") {
      io.writeErr(`ShipFix can't start a fix while the run is ${status ?? "unknown"}.`);
      return 1;
    }
    const next = await request(io, `/runs/${runId}/deploy`, { method: "POST" });
    if (!next.ok) {
      io.writeErr(next.message);
      return 1;
    }
    const nextId = (next.body as { runId?: string }).runId ?? runId;
    io.write(`Repair started.\nrunId: ${nextId}`);
    return 0;
  }

  io.writeErr(help());
  return 1;
}
