import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // TODO: load from a validated env module; never hardcode credentials.
    url: process.env.DATABASE_URL ?? "postgres://shipfix:shipfix@localhost:5432/shipfix",
  },
});
