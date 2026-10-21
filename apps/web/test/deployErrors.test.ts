import { describe, expect, it } from "vitest";
import { CORPUS_REPO_COUNT, deployErrorBySlug, deployErrors } from "../app/lib/deployErrors";

describe("deploy error pages", () => {
  it("publishes the common corpus issues and the log failures ShipFix names", () => {
    const slugs = deployErrors.map((error) => error.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.every((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))).toBe(true);
    expect(deployErrorBySlug("missing-secret")?.corpusCount).toBe(118);
    expect(deployErrorBySlug("unknown-provider-project")?.corpusCount).toBe(25);
    expect(deployErrorBySlug("missing-health-check")?.corpusCount).toBe(6);
    expect(deployErrors.filter((error) => error.source === "corpus")).toHaveLength(3);
    expect(deployErrors.filter((error) => error.corpusCount != null).every((error) => error.corpusCount! <= CORPUS_REPO_COUNT)).toBe(true);
    expect(deployErrors.every((error) => error.title && error.whatHappened && error.whatShipFixDoes)).toBe(true);
  });
});
