import { describe, it, expect } from "vitest";
import { formatDeployFailureDetail, parseRenderResponse, renderApiError } from "../src/renderHttp";

function response(body: string, status = 200, statusText = "OK"): Response {
  return new Response(body, { status, statusText, headers: { "content-type": "application/json" } });
}

describe("parseRenderResponse", () => {
  it("parses JSON success body", async () => {
    const json = await parseRenderResponse(response('{"id":"srv_1"}'), "get service");
    expect(json).toEqual({ id: "srv_1" });
  });

  it("returns null for empty successful body when allowEmptyOk", async () => {
    const json = await parseRenderResponse(response("", 202, "Accepted"), "trigger deploy", {
      allowEmptyOk: true,
    });
    expect(json).toBeNull();
  });

  it("returns null for empty 204-style success without allowEmptyOk", async () => {
    const json = await parseRenderResponse(response("", 200), "patch service");
    expect(json).toBeNull();
  });

  it("throws redacted error for empty error response", async () => {
    await expect(parseRenderResponse(response("", 500, "Internal Server Error"), "create service")).rejects.toThrow(
      /Render API create service failed \(HTTP 500/,
    );
    await expect(parseRenderResponse(response("", 500, "Internal Server Error"), "create service")).rejects.toThrow(
      /empty body/,
    );
  });

  it("throws redacted error for non-JSON error response", async () => {
    await expect(
      parseRenderResponse(response("upstream connect error", 502, "Bad Gateway"), "list services"),
    ).rejects.toThrow(/Render API list services failed \(HTTP 502/);
    await expect(
      parseRenderResponse(response("upstream connect error", 502, "Bad Gateway"), "list services"),
    ).rejects.not.toThrow(/Unexpected end of JSON input/);
  });

  it("throws when error response body is malformed JSON", async () => {
    await expect(
      parseRenderResponse(response('{"message":', 429, "Too Many Requests"), "trigger deploy"),
    ).rejects.toThrow(/Render API trigger deploy failed \(HTTP 429/);
  });
});

describe("renderApiError", () => {
  it("includes action, status, and body preview", () => {
    const res = new Response("not json {", { status: 400, statusText: "Bad Request" });
    const err = renderApiError("get deploy", res, "not json {");
    expect(err.message).toContain("Render API get deploy failed");
    expect(err.message).toContain("HTTP 400");
    expect(err.message).toContain("not json");
  });
});

describe("formatDeployFailureDetail", () => {
  it("includes service id, deploy id, status, and dashboard hint", () => {
    const msg = formatDeployFailureDetail({
      serviceId: "srv_abc",
      deployId: "dpl_123",
      action: "deploy",
      status: "build_failed",
    });
    expect(msg).toContain("srv_abc");
    expect(msg).toContain("dpl_123");
    expect(msg).toContain("build_failed");
    expect(msg).toContain("Render dashboard");
  });
});
