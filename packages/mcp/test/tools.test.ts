import { describe, expect, it } from "vitest";
import { createShipfixClient } from "../src/client";
import { encodeFrame, handleRpc, takeFrame } from "../src/rpc";
import { fixTool, logsTool, summarizeStatus } from "../src/tools";

const RUN = "11111111-1111-4111-8111-111111111111";

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

describe("shipfix client", () => {
  it("deploys with a dev user header and never puts the token on the wire when dev user is set", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "/runs/deploy": { status: 202, body: { runId: RUN, mode: "deploy" } },
    });
    const client = createShipfixClient({
      baseUrl: "http://localhost:4000/",
      token: "secret-token",
      devUser: "local-dev",
      fetchImpl,
    });
    const body = (await client.deploy({ repo: "acme/app", branch: "main" })) as { runId: string };
    expect(body.runId).toBe(RUN);
    expect(calls[0]?.headers["x-shipfix-dev-user"]).toBe("local-dev");
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ repoFullName: "acme/app", branch: "main" });
  });

  it("sends a bearer token and treats a github url as repoUrl", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "/runs/deploy": { status: 202, body: { runId: RUN } },
    });
    const client = createShipfixClient({ baseUrl: "http://localhost:4000", token: "secret-token", fetchImpl });
    await client.deploy({ repo: "https://github.com/acme/app" });
    expect(calls[0]?.headers.authorization).toBe("Bearer ***");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ repoUrl: "https://github.com/acme/app" });
  });
});

describe("tools", () => {
  it("summarizes live urls and unanswered questions", () => {
    const text = summarizeStatus({
      run: { id: RUN, status: "awaiting_input", repoFullName: "acme/app", branch: "main" },
      plan: {
        classification: "needs_setup",
        questions: [
          { id: "q1", prompt: "Database url?" },
          { id: "q2", prompt: "Already answered" },
        ],
      },
      answeredQuestionIds: ["q2"],
      resources: [{ role: "web", url: "https://app.example", status: "live" }],
    });
    expect(text).toContain("awaiting_input");
    expect(text).toContain("https://app.example");
    expect(text).toContain("Database url?");
    expect(text).not.toContain("Already answered");
  });

  it("returns log lines oldest first", async () => {
    const { fetchImpl } = fakeFetch({
      [`/runs/${RUN}/logs?limit=80`]: {
        body: { lines: [{ seq: 1, level: "info", message: "cloned" }, { seq: 2, level: "error", message: "build failed" }] },
      },
    });
    const client = createShipfixClient({ baseUrl: "http://localhost:4000", devUser: "local-dev", fetchImpl });
    expect(await logsTool(client, RUN)).toBe("[info] cloned\n[error] build failed");
  });

  it("does not redeploy a run that is waiting on the user", async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`/runs/${RUN}`]: {
        body: {
          run: { id: RUN, status: "awaiting_input" },
          plan: { questions: [{ id: "q1", prompt: "What is API_KEY?" }] },
          answeredQuestionIds: [],
        },
      },
    });
    const client = createShipfixClient({ baseUrl: "http://localhost:4000", devUser: "local-dev", fetchImpl });
    const text = await fixTool(client, RUN);
    expect(text).toContain("waiting for you");
    expect(text).toContain("API_KEY");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("redeploys a failed run so the repair loop can run", async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`/runs/${RUN}`]: { body: { run: { id: RUN, status: "failed" } } },
      [`/runs/${RUN}/deploy`]: { status: 202, body: { runId: RUN, mode: "deploy" } },
    });
    const client = createShipfixClient({ baseUrl: "http://localhost:4000", devUser: "local-dev", fetchImpl });
    const text = await fixTool(client, RUN);
    expect(text).toContain("Repair started");
    expect(calls.at(-1)?.method).toBe("POST");
    expect(calls.at(-1)?.url).toContain(`/runs/${RUN}/deploy`);
  });
});

describe("mcp rpc", () => {
  it("frames a message and lists the four tools", async () => {
    const framed = encodeFrame({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const taken = takeFrame(framed);
    expect(taken?.rest.length).toBe(0);
    const client = createShipfixClient({ baseUrl: "http://localhost:4000", devUser: "x", fetchImpl: async () => new Response("{}") });
    const response = (await handleRpc(taken?.message as { method: string; id: number }, client)) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(response.result.tools.map((t) => t.name)).toEqual(["deploy", "status", "logs", "fix"]);
  });

  it("calls deploy through tools/call and surfaces API errors as tool errors", async () => {
    const { fetchImpl } = fakeFetch({
      "/runs/deploy": { status: 400, body: { message: "Provide a repo" } },
    });
    const client = createShipfixClient({ baseUrl: "http://localhost:4000", token: "t", fetchImpl });
    const response = (await handleRpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "deploy", arguments: { repo: "acme/app" } } },
      client,
    )) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toBe("Provide a repo");
  });

  it("ignores the initialized notification", async () => {
    const client = createShipfixClient({ baseUrl: "http://localhost:4000", fetchImpl: async () => new Response("{}") });
    expect(await handleRpc({ method: "notifications/initialized" }, client)).toBeNull();
  });
});
