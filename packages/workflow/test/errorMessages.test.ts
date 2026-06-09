import { describe, expect, it } from "vitest";
import { failureEventForMessage, unwrapFailureMessage } from "../src/errorMessages";

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
});
