import { describe, expect, it } from "vitest";
import { LLMProviderError } from "@shipfix/llm";
import { failureEventForError, failureEventForMessage, unwrapFailureMessage } from "../src/errorMessages";

describe("workflow failure messages", () => {
  it("unwraps Temporal's generic activity failure message", () => {
    const err = new Error("Activity task failed", {
      cause: new Error("OpenAI LLM gateway not configured. Set OPENAI_API_KEY."),
    });

    expect(unwrapFailureMessage(err)).toBe("OpenAI LLM gateway not configured. Set OPENAI_API_KEY.");
  });

  it("classifies alpha usage limit failures", () => {
    expect(failureEventForMessage("You've reached the alpha usage limit. Try again later.")).toMatchObject({
      event: "usage_limit_reached",
      title: "Usage limit reached",
    });
  });

  it("classifies missing worker LLM configuration", () => {
    expect(failureEventForMessage("LLM gateway not configured. Set LLM_PROVIDER and LLM_MODEL.")).toMatchObject({
      event: "llm_config_missing",
      title: "Planner setup is missing",
    });
  });

  it("classifies ShipFix metering messages as usage limits", () => {
    expect(
      failureEventForMessage("Usage limit reached: llm_run_limit (3 LLM calls per run). Try again later."),
    ).toMatchObject({ event: "usage_limit_reached" });
  });

  it("does NOT mislabel transient provider errors as usage limits", () => {
    // Provider 503 bodies often contain "try again later" — that must surface
    // as llm_unavailable, not usage_limit_reached.
    const err = new LLMProviderError({
      kind: "unavailable",
      status: 503,
      detail: '{"error":"The model is overloaded. Please try again later."}',
    });
    expect(failureEventForMessage(err.message)).toMatchObject({
      event: "llm_unavailable",
      title: "AI planner temporarily unavailable",
    });
    expect(failureEventForError(err)).toMatchObject({ event: "llm_unavailable" });
  });

  it("classifies provider rate limits and timeouts as llm_unavailable", () => {
    expect(failureEventForError(new LLMProviderError({ kind: "rate_limited", status: 429 }))).toMatchObject({
      event: "llm_unavailable",
    });
    expect(failureEventForError(new LLMProviderError({ kind: "timeout" }))).toMatchObject({
      event: "llm_unavailable",
    });
  });

  it("classifies provider auth failures as invalid planner setup", () => {
    expect(failureEventForError(new LLMProviderError({ kind: "auth", status: 401 }))).toMatchObject({
      event: "llm_config_missing",
      title: "Planner setup is invalid",
    });
  });

  it("falls back to message classification for plain errors", () => {
    expect(failureEventForError(new Error("planner produced invalid JSON"))).toMatchObject({
      event: "planning_failed",
    });
  });

  it("classifies missing run rows as control-plane consistency failures", () => {
    expect(
      failureEventForMessage("Run af0c11c3-94a1-4b97-b415-7ea2801b3c78 not found in worker database."),
    ).toMatchObject({
      event: "internal_control_plane_consistency_error",
    });
  });
});
