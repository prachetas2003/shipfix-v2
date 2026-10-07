import { describe, expect, it } from "vitest";
import { synthesizeDeterministicPlan } from "@shipfix/planner";
import { capabilities, validatePlan } from "@shipfix/validator";
import { analyzeRepo } from "../src/index";

function repo(files: Record<string, string | object>) {
  const text = Object.fromEntries(
    Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );
  return { listFiles: async () => Object.keys(text), readFile: async (p: string) => text[p] ?? null };
}

describe("NestJS backends", () => {
  it("finds decorator routes under the global prefix and plans a Render API", async () => {
    const ctx = await analyzeRepo(
      repo({
        "package.json": {
          name: "api",
          scripts: { build: "nest build", start: "nest start", "start:prod": "node dist/main" },
          dependencies: { "@nestjs/core": "11", "@nestjs/common": "11" },
          devDependencies: { "@nestjs/cli": "11" },
        },
        "package-lock.json": "{}",
        "src/main.ts": "const app = await NestFactory.create(AppModule);\napp.setGlobalPrefix('api');\nawait app.listen(process.env.PORT ?? 3000);",
        "src/health/health.controller.ts": "@Controller('health')\nexport class HealthController {\n  @Get()\n  check() { return { ok: true }; }\n}",
        "src/users/users.controller.ts": "@Controller({ path: 'users' })\nexport class UsersController {\n  @Get(':id')\n  one() {}\n  @Get('me')\n  me() {}\n}",
      }),
      { repoFullName: "t/t", commitSha: "0".repeat(40) },
    );
    const paths = ctx.services[0].routeCandidates.map((r) => r.path);
    expect(paths).toContain("/api/health");
    expect(paths).toContain("/api/users/me");
    expect(paths.some((p) => p.includes(":"))).toBe(false);

    const plan = synthesizeDeterministicPlan(ctx)!;
    expect(plan.services[0]).toMatchObject({ type: "node_api", start: "npm run start:prod", healthCheckPath: "/api/health" });
    const res = validatePlan(plan, ctx, capabilities({ render: ["node_api"] }, []));
    expect(res.plan.classification).toBe("deployable");
  });
});
