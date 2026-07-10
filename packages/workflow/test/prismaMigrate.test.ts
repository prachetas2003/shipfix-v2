import { describe, expect, it } from "vitest";
import {
  findPrismaSchemaPath,
  hasPrismaMigrations,
  prismaMigrateCommand,
} from "../src/prismaMigrate";

describe("prismaMigrate helpers", () => {
  it("prefers schema under the API rootDir", () => {
    const files = ["apps/web/schema.prisma", "apps/api/prisma/schema.prisma"];
    expect(findPrismaSchemaPath(files, "apps/api")).toBe("apps/api/prisma/schema.prisma");
  });

  it("detects migrations next to the schema", () => {
    expect(
      hasPrismaMigrations(
        ["apps/api/prisma/schema.prisma", "apps/api/prisma/migrations/20240101_init/migration.sql"],
        "apps/api/prisma/schema.prisma",
      ),
    ).toBe(true);
    expect(hasPrismaMigrations(["apps/api/prisma/schema.prisma"], "apps/api/prisma/schema.prisma")).toBe(
      false,
    );
  });

  it("builds a package-manager-aware migrate command", () => {
    expect(prismaMigrateCommand("apps/api/prisma/schema.prisma", "pnpm")).toContain(
      "pnpm exec prisma migrate deploy",
    );
    expect(prismaMigrateCommand("prisma/schema.prisma", "npm")).toContain("npx prisma migrate deploy");
  });
});
