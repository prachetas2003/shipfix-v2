import { describe, it, expect } from "vitest";
import {
  findDrizzleConfigPath,
  hasDrizzleMigrations,
  drizzleMigrateCommand,
} from "../src/drizzleMigrate";

describe("drizzleMigrate helpers", () => {
  it("finds drizzle.config under preferred root", () => {
    const files = ["apps/web/package.json", "apps/api/drizzle.config.ts", "apps/api/drizzle/0000.sql"];
    expect(findDrizzleConfigPath(files, "apps/api")).toBe("apps/api/drizzle.config.ts");
  });

  it("detects drizzle migrations folder", () => {
    expect(
      hasDrizzleMigrations(
        ["apps/api/drizzle.config.ts", "apps/api/drizzle/0000_init.sql"],
        "apps/api/drizzle.config.ts",
      ),
    ).toBe(true);
    expect(hasDrizzleMigrations(["apps/api/drizzle.config.ts"], "apps/api/drizzle.config.ts")).toBe(
      false,
    );
  });

  it("builds package-manager migrate commands", () => {
    expect(drizzleMigrateCommand("pnpm")).toContain("drizzle-kit migrate");
    expect(drizzleMigrateCommand("npm")).toContain("drizzle-kit migrate");
  });
});
