import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP_DIR = path.resolve(fileURLToPath(new URL("../app", import.meta.url)));
const FILES = [
  "lib/api.ts",
  "new/page.tsx",
  "components/ConnectProvider.tsx",
  "components/ProviderRequirements.tsx",
];

describe("frontend env exposure", () => {
  it("does not reference backend-only LLM API key env vars", () => {
    const haystack = FILES.map((file) => readFileSync(path.join(APP_DIR, file), "utf8")).join("\n");
    expect(haystack).not.toMatch(/OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY|LLM_API_KEY|LLM_PROVIDER|LLM_MODEL/);
    expect(haystack).toContain("NEXT_PUBLIC_API_URL");
  });
});
