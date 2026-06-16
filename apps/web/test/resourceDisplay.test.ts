import { describe, it, expect } from "vitest";
import {
  buildAppResourceDisplay,
  safeExternalHref,
  fullStackSummary,
} from "../app/lib/resourceDisplay";
import type { RunLayers, SnapshotResource, VerificationEntry } from "../app/lib/api";

const layers: RunLayers = {
  database: { state: "live", url: "ep-winter-breeze-afsx6a1g.c-2.us-west-2.aws.neon.tech", provider: "neon", detail: "Live" },
  backend: {
    state: "live",
    url: "https://shipfix-b015561e-4a18-491c-998d.onrender.com",
    provider: "render",
    detail: "Live",
  },
  frontend: {
    state: "live",
    url: "https://shipfix-b015561e-4a18-491c-998d-b3b.vercel.app",
    provider: "vercel",
    detail: "Live",
  },
  fullStack: { live: true, detail: "Your app is live." },
};

const resources: SnapshotResource[] = [
  {
    serviceId: "db",
    role: "database",
    kind: "managed_db",
    provider: "neon",
    url: "ep-winter-breeze-afsx6a1g.c-2.us-west-2.aws.neon.tech",
    status: "live",
    exposesEnv: "DATABASE_URL",
  },
  {
    serviceId: "api",
    role: "backend",
    kind: "service",
    provider: "render",
    url: "https://shipfix-b015561e-4a18-491c-998d.onrender.com",
    status: "live",
    exposesEnv: null,
  },
  {
    serviceId: "web",
    role: "frontend",
    kind: "service",
    provider: "vercel",
    url: "https://shipfix-b015561e-4a18-491c-998d-b3b.vercel.app",
    status: "live",
    exposesEnv: null,
  },
];

const verification: VerificationEntry[] = [
  {
    serviceId: "api",
    check: "health_path",
    ok: true,
    skipped: false,
    statusCode: 200,
    url: "https://shipfix-b015561e-4a18-491c-998d.onrender.com/health",
    assumedPath: false,
  },
];

describe("safeExternalHref", () => {
  it("accepts https URLs", () => {
    expect(safeExternalHref("https://app.vercel.app")).toBe("https://app.vercel.app");
  });

  it("rejects bare hostnames so they are never used as relative hrefs", () => {
    expect(safeExternalHref("ep-winter-breeze-afsx6a1g.c-2.us-west-2.aws.neon.tech")).toBeNull();
    expect(safeExternalHref("shipfix-abc.onrender.com")).toBeNull();
  });
});

describe("buildAppResourceDisplay", () => {
  const display = buildAppResourceDisplay({ resources, layers, verification })!;

  it("renders frontend as primary Open App link", () => {
    expect(display.frontend?.openAppUrl).toBe("https://shipfix-b015561e-4a18-491c-998d-b3b.vercel.app");
    expect(safeExternalHref(display.frontend?.openAppUrl)).toBe(display.frontend?.openAppUrl);
  });

  it("renders backend base URL and verified health check URL separately", () => {
    expect(display.backend?.baseUrl).toBe("https://shipfix-b015561e-4a18-491c-998d.onrender.com");
    expect(display.backend?.healthCheckUrl).toBe(
      "https://shipfix-b015561e-4a18-491c-998d.onrender.com/health",
    );
    expect(display.backend?.healthCheckPassed).toBe(true);
  });

  it("renders database as metadata host without a browser href", () => {
    expect(display.database?.host).toBe("ep-winter-breeze-afsx6a1g.c-2.us-west-2.aws.neon.tech");
    expect(safeExternalHref(display.database?.host)).toBeNull();
  });

  it("keeps full-stack live when backend root may 404 but health check passed", () => {
    expect(display.fullStack.live).toBe(true);
    expect(display.backend?.healthCheckPassed).toBe(true);
    expect(fullStackSummary(display)).toContain("health check passed");
  });

  it("shows not proven live when resource URLs exist but verification failed", () => {
    const display = buildAppResourceDisplay({
      resources,
      layers: {
        ...layers,
        fullStack: { live: false, detail: "All parts have URLs, but live verification failed." },
      },
      verification: [
        {
          serviceId: "api",
          check: "health_path",
          ok: false,
          skipped: false,
          statusCode: 500,
          url: "https://shipfix-b015561e-4a18-491c-998d.onrender.com/health",
          assumedPath: false,
        },
      ],
    })!;
    expect(display.frontend?.openAppUrl).toContain("vercel.app");
    expect(display.fullStack.live).toBe(false);
    expect(fullStackSummary(display)).toContain("verification failed");
  });

  it("never uses database host as a browser link or app route", () => {
    const projectId = "b015561e-4a18-491c-998d-a53c-bb8e9789e514";
    const host = display.database?.host ?? "";
    expect(projectId).not.toBe(host);
    expect(safeExternalHref(host)).toBeNull();
    expect(host).not.toMatch(/^https?:\/\//);
  });

  it("derives health URL from plan when verification passed without a url field", () => {
    const display = buildAppResourceDisplay({
      resources,
      layers,
      verification: [
        {
          serviceId: "api",
          check: "health_path",
          ok: true,
          skipped: false,
          statusCode: 200,
          url: null,
          assumedPath: false,
        },
      ],
      plan: { services: [{ id: "api", type: "node_api", healthCheckPath: "/health" }] },
    })!;
    expect(display.backend?.healthCheckUrl).toBe(
      "https://shipfix-b015561e-4a18-491c-998d.onrender.com/health",
    );
    expect(display.backend?.healthCheckPassed).toBe(true);
  });
});
