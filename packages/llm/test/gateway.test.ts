import { afterEach, describe, it, expect } from "vitest";
import { z } from "zod";
import { createLLMGateway, extractJsonBlock, parseStructured, redactingGateway } from "../src/index";
import { createFakeGateway } from "../src/testing";

describe("extractJsonBlock", () => {
  it("reads a bare JSON object", () => {
    expect(extractJsonBlock('{"a":1}')).toBe('{"a":1}');
  });
  it("strips ```json fences", () => {
    expect(extractJsonBlock("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });
  it("ignores surrounding prose", () => {
    expect(extractJsonBlock('Here you go:\n{"a":1}\nThanks!')).toBe('{"a":1}');
  });
  it("returns null when there is no object", () => {
    expect(extractJsonBlock("no json here")).toBeNull();
  });
});

describe("parseStructured", () => {
  const schema = z.object({ name: z.string(), count: z.number() });
  it("parses + validates conforming output", () => {
    const r = parseStructured('{"name":"x","count":2}', schema);
    expect(r).toEqual({ ok: true, data: { name: "x", count: 2 } });
  });
  it("reports a schema error for non-conforming output", () => {
    const r = parseStructured('{"name":"x"}', schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("count");
  });
});

describe("redactingGateway", () => {
  it("redacts secrets in system + user before they reach the inner gateway", async () => {
    const fake = createFakeGateway("ok");
    const wrapped = redactingGateway(fake.gateway);

    await wrapped.complete({
      system: `token=ghp_${"a".repeat(36)}`,
      user: `db=postgres://user:pw@host:5432/db`,
    });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].system).not.toContain("ghp_");
    expect(fake.calls[0].system).toContain("[REDACTED]");
    expect(fake.calls[0].user).not.toContain("postgres://");
    expect(fake.calls[0].user).toContain("[REDACTED]");
  });

  it("preserves the inner model id", () => {
    const fake = createFakeGateway("ok", "claude-test");
    expect(redactingGateway(fake.gateway).model).toBe("claude-test");
  });
});

describe("createLLMGateway env handling", () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("accepts legacy LLM_API_KEY as a backward-compatible fallback", () => {
    process.env = {
      ...OLD_ENV,
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: "claude-test",
      LLM_API_KEY: "legacy-user-style-key",
      ANTHROPIC_API_KEY: "",
    };
    expect(createLLMGateway().model).toBe("claude-test");
  });

  it("names the exact missing provider key when neither preferred nor legacy key is set", () => {
    process.env = {
      ...OLD_ENV,
      LLM_PROVIDER: "gemini",
      LLM_MODEL: "gemini-test",
      GEMINI_API_KEY: "",
      LLM_API_KEY: "",
    };
    expect(() => createLLMGateway()).toThrow(/GEMINI_API_KEY.*LLM_API_KEY/);
  });

  it("constructs OpenAI gateway from OPENAI_API_KEY", () => {
    process.env = {
      ...OLD_ENV,
      LLM_PROVIDER: "openai",
      LLM_MODEL: "gpt-test",
      OPENAI_API_KEY: "sk-" + "a".repeat(30),
    };
    expect(createLLMGateway().model).toBe("gpt-test");
  });
});
