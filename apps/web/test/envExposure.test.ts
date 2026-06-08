import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP_DIR = path.resolve(fileURLToPath(new URL("../app", import.meta.url)));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(full) ? [full] : [];
  });
}

describe("frontend env exposure", () => {
  it("does not reference backend-only secret env vars", () => {
    const haystack = files(APP_DIR).map((file) => readFileSync(file, "utf8")).join("\n");
    expect(haystack).not.toMatch(
      /OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY|LLM_API_KEY|LLM_PROVIDER|LLM_MODEL|CLERK_SECRET_KEY|VERCEL_TOKEN|RENDER_API_KEY|NEON_API_KEY|SHIPFIX_ADMIN_TOKEN|SHIPFIX_MASTER_KEY/,
    );
    expect(haystack).not.toMatch(/window\.prompt|shipfix_alpha_token|X-ShipFix-Alpha-User|alpha_token/);
    expect(haystack).toContain("NEXT_PUBLIC_API_URL");
    expect(haystack).toContain("NEXT_PUBLIC_AUTH_MODE");
  });
});
