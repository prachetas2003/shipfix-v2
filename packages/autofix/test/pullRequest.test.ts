import { describe, expect, it } from "vitest";
import { commitMessage, pullRequestBody, pullRequestTitle, type PullRequestFix } from "../src/index";

const port: PullRequestFix = {
  serviceId: "api",
  title: "Listen on the port the host assigns",
  explanation: "The server used a fixed port.",
  fullyVerified: true,
  files: [{ path: "server.js", created: false }],
};
const types: PullRequestFix = {
  serviceId: "web",
  title: "Fix the build",
  explanation: "A value was typed as a number but was a string.",
  fullyVerified: false,
  files: [{ path: "src/App.tsx", created: false }, { path: "src/types.ts", created: true }, { path: "server.js", created: false }],
};

describe("pull request text", () => {
  it("titles one fix by name and several by count", () => {
    expect(pullRequestTitle([port])).toBe("ShipFix: Listen on the port the host assigns");
    expect(pullRequestTitle([port, types])).toBe("ShipFix: fix 2 deploy problems");
  });

  it("explains a single fix, the files, the test, and how to undo", () => {
    const body = pullRequestBody({ fixes: [port], baseBranch: "main", repairBranch: "shipfix/fix-1" });
    expect(body).toContain("deployed from `shipfix/fix-1`");
    expect(body).toContain("## What was wrong\n\nThe server used a fixed port.");
    expect(body).toContain("- `server.js`");
    expect(body).toContain("The build passed.");
    expect(body).toContain("**Close** to reject it. Your next deploy goes back to `main`");
    expect(body.trim().endsWith("Fixed by ShipFix")).toBe(true);
  });

  it("lists each fix, dedupes files, and flags partial verification", () => {
    const body = pullRequestBody({ fixes: [port, types], baseBranch: "main", repairBranch: "shipfix/fix-1" });
    expect(body).toContain("**Fix the build** (`web`)");
    expect(body.match(/- `server\.js`/g)).toHaveLength(1);
    expect(body).toContain("- `src/types.ts` (new file)");
    expect(body).toContain("For `web`, the build got past the original error");
  });

  it("writes a commit message with a summary line and footer", () => {
    expect(commitMessage([port])).toBe("Listen on the port the host assigns\n\nThe server used a fixed port.\n\nFixed by ShipFix");
  });
});
