import { describe, expect, it } from "vitest";
import {
  ONE_ENVIRONMENT_NOTE,
  attachHostname,
  backupTarget,
  deleteProviderResource,
  domainTarget,
  planTeardown,
  validHostname,
} from "../src/index";

describe("guardian extras", () => {
  it("deletes services before databases and leaves Supabase in place", () => {
    const steps = planTeardown([
      { provider: "neon", externalId: "proj", kind: "managed_db", serviceId: "db" },
      { provider: "supabase", externalId: "ref", kind: "managed_db", serviceId: "supa" },
      { provider: "vercel", externalId: "prj_1", kind: "service", serviceId: "web" },
      { provider: "vercel", externalId: "prj_1", kind: "service", serviceId: "web" },
    ]);
    expect(steps.map((step) => `${step.action}:${step.provider}`)).toEqual(["delete:vercel", "delete:neon", "skip:supabase"]);
  });

  it("backs up Neon ahead of Supabase and attaches a domain to the frontend host", () => {
    const resources = [
      { provider: "render", externalId: "srv-1", kind: "service", serviceId: "api" },
      { provider: "vercel", externalId: "prj_1", kind: "service", serviceId: "web" },
      { provider: "neon", externalId: "proj", kind: "managed_db", serviceId: "db" },
      { provider: "supabase", externalId: "ref", kind: "managed_db", serviceId: "supa" },
    ];
    expect(backupTarget(resources)).toEqual({ provider: "neon", externalId: "proj" });
    expect(domainTarget(resources)).toEqual({ provider: "vercel", externalId: "prj_1" });
    expect(validHostname("App.Example.com.")).toBe("app.example.com");
    expect(validHostname("localhost")).toBeNull();
    expect(ONE_ENVIRONMENT_NOTE).toContain("one environment");
  });

  it("treats a missing provider resource as removed and does not return the response body", async () => {
    let seenAuth = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      seenAuth = String((init?.headers as { authorization?: string } | undefined)?.authorization ?? "");
      return new Response(JSON.stringify({ token: "secret-body" }), { status: 404 });
    };
    const result = await deleteProviderResource(
      { provider: "vercel", externalId: "prj_1", kind: "service", serviceId: "web", action: "delete", reason: null },
      { vercelToken: "tok" },
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    expect(result.line).toBe("Removed vercel prj_1.");
    expect(result.line).not.toContain("secret-body");
    expect(seenAuth).toBe("Bearer tok");
  });

  it("asks for the DNS record Vercel returns", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ verified: false, verification: [{ type: "TXT", domain: "_vercel.app.example.com", value: "vc-domain-verify" }] }), { status: 200 });
    const result = await attachHostname(
      { provider: "vercel", externalId: "prj_1" },
      "app.example.com",
      { vercelToken: "tok" },
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    expect(result.lines.some((line) => line.includes("TXT") && line.includes("vc-domain-verify"))).toBe(true);
  });
});
