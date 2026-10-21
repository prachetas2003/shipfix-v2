import { describe, expect, it } from "vitest";
import { runShipfix, type ShipfixIo } from "../src/run.ts";

const RUN = "11111111-1111-4111-8111-111111111111";
const TOKEN = "secret-token-value";

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = key === "authorization" ? "Bearer ***" : value;
    });
    calls.push({ url, method: init?.method ?? "GET", headers, body: init?.body ? String(init.body) : undefined });
    const route = Object.entries(routes).find(([path]) => url.endsWith(path));
    if (!route) return new Response("missing", { status: 404 });
    return new Response(JSON.stringify(route[1].body), { status: route[1].status ?? 200 });
  };
  return { fetchImpl, calls };
}

function harness(argv: string[], fetchImpl: typeof fetch, env: ShipfixIo["env"] = { SHIPFIX_TOKEN: TOKEN }): {
  io: ShipfixIo;
  out: () => string;
  err: () => string;
} {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      argv,
      env,
      fetchImpl,
      write: (line) => lines.push(line),
      writeErr: (line) => errors.push(line),
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => (t += 1_000);
      })(),
    },
    out: () => lines.join("\n"),
    err: () => errors.join("\n"),
  };
}

describe("shipfix cli", () => {
  it("deploys owner/repo and does not print the token", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "/runs/deploy": { status: 202, body: { runId: RUN, mode: "deploy" } },
    });
    const { io, out, err } = harness(["deploy", "acme/app", "--branch", "main"], fetchImpl);
    expect(await runShipfix(io)).toBe(0);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ repoFullName: "acme/app", branch: "main" });
    expect(calls[0]?.headers.authorization).toBe("Bearer ***");
    expect(out()).toContain(`runId: ${RUN}`);
    expect(`${out()}\n${err()}`).not.toContain(TOKEN);
  });

  it("uses the GitHub Action repository when no argument is passed", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "/runs/deploy": { status: 202, body: { runId: RUN } },
    });
    const { io } = harness(["deploy"], fetchImpl, {
      SHIPFIX_TOKEN: TOKEN,
      GITHUB_REPOSITORY: "acme/from-actions",
      SHIPFIX_BRANCH: "release",
    });
    expect(await runShipfix(io)).toBe(0);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ repoFullName: "acme/from-actions", branch: "release" });
  });

  it("waits until the deploy succeeds", async () => {
    let polls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/runs/deploy")) return new Response(JSON.stringify({ runId: RUN }), { status: 202 });
      polls++;
      const status = polls < 2 ? "deploying" : "succeeded";
      return new Response(JSON.stringify({ run: { id: RUN, status, repoFullName: "acme/app" } }));
    };
    const { io, out } = harness(["deploy", "acme/app", "--wait"], fetchImpl);
    expect(await runShipfix(io)).toBe(0);
    expect(out()).toContain("succeeded");
  });

  it("exits 2 when the deploy is waiting for an answer", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/runs/deploy")) return new Response(JSON.stringify({ runId: RUN }), { status: 202 });
      return new Response(
        JSON.stringify({
          run: { id: RUN, status: "awaiting_input" },
          plan: { questions: [{ id: "q1", prompt: "What is DATABASE_URL?" }] },
        }),
      );
    };
    const { io, out } = harness(["deploy", "--wait"], fetchImpl, { SHIPFIX_DEV_USER: "local-dev", SHIPFIX_REPO: "acme/app" });
    expect(await runShipfix(io)).toBe(2);
    expect(out()).toContain("DATABASE_URL");
  });

  it("prints help for --help", async () => {
    const { io, out } = harness(["--help"], (async () => new Response("no")) as typeof fetch, {});
    expect(await runShipfix(io)).toBe(0);
    expect(out()).toContain("shipfix deploy");
  });

  it("refuses to run without auth and does not call the API", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("no");
    };
    const { io, err } = harness(["deploy", "acme/app"], fetchImpl, {});
    expect(await runShipfix(io)).toBe(1);
    expect(called).toBe(false);
    expect(err()).toContain("SHIPFIX_TOKEN");
  });

  it("redeploys a failed run", async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`/runs/${RUN}`]: { body: { run: { id: RUN, status: "failed" } } },
      [`/runs/${RUN}/deploy`]: { status: 202, body: { runId: "22222222-2222-4222-8222-222222222222" } },
    });
    const { io, out } = harness(["fix", RUN], fetchImpl);
    expect(await runShipfix(io)).toBe(0);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith(`/runs/${RUN}/deploy`))).toBe(true);
    expect(out()).toContain("22222222-2222-4222-8222-222222222222");
  });
});
