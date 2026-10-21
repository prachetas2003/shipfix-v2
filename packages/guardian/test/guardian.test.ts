import { describe, expect, it } from "vitest";
import { incidentText, notifySlack, probeHealth, probeUrl, rollbackCommit, summarizeCheck } from "../src/index";

describe("guardian", () => {
  it("joins a health path onto the live URL", () => {
    expect(probeUrl({ serviceId: "api", url: "https://api.example/", healthPath: "/health" })).toBe("https://api.example/health");
    expect(probeUrl({ serviceId: "web", url: "https://app.example", healthPath: null })).toBe("https://app.example");
  });

  it("marks a refused connection as down and a 2xx as up", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/health")) return new Response("ok", { status: 200 });
      return new Response("no", { status: 503 });
    };
    const results = await probeHealth(
      [
        { serviceId: "api", url: "https://api.example", healthPath: "/health" },
        { serviceId: "web", url: "https://app.example" },
      ],
      fetchImpl,
    );
    const summary = summarizeCheck(results);
    expect(summary.ok).toBe(false);
    expect(summary.lines).toEqual(["api answered 200", "web returned 503"]);
    expect(incidentText("acme/app", summary)).toContain("web returned 503");
  });

  it("rolls back to the previous succeeded commit", () => {
    expect(
      rollbackCommit(
        [
          { status: "succeeded", commitSha: "new" },
          { status: "failed", commitSha: "bad" },
          { status: "succeeded", commitSha: "old" },
        ],
        "new",
      ),
    ).toBe("old");
    expect(rollbackCommit([{ status: "succeeded", commitSha: "only" }], "only")).toBeNull();
  });

  it("sends a Slack message without returning the webhook", async () => {
    let seen = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      seen = String(input);
      expect(String(init?.body)).toContain("acme/app");
      expect(String(init?.body)).not.toContain("hooks.slack.test");
      return new Response("ok", { status: 200 });
    };
    const webhook = "https://hooks.slack.test/services/secret";
    expect(await notifySlack(webhook, incidentText("acme/app", summarizeCheck([])), fetchImpl)).toBe(true);
    expect(seen).toBe(webhook);
  });
});
