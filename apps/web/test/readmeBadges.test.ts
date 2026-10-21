import { describe, expect, it } from "vitest";
import { readmeMarkdown } from "../app/lib/readmeBadges";

describe("readmeMarkdown", () => {
  it("builds a deploy button and a checked badge from the site origin", () => {
    expect(readmeMarkdown("https://shipfix.dev/")).toEqual({
      button: "[![Deploy with ShipFix](https://shipfix.dev/deploy-button.svg)](https://shipfix.dev/new)",
      badge: "[![Deployed and checked by ShipFix](https://shipfix.dev/badge.svg)](https://shipfix.dev)",
    });
  });
});
