import { it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listSupabaseMigrations, tablesWithoutRls } from "../src/supabaseMigrations";

it("probe", async () => {
  const base = join(process.env.TEMP!, "rlscheck");
  for (const repo of readdirSync(base)) {
    const dir = join(base, repo, "supabase", "migrations");
    const files = new Set(readdirSync(dir).map((f) => `supabase/migrations/${f}`));
    const migrations = listSupabaseMigrations(files);
    const open = await tablesWithoutRls(
      { listFiles: async () => [...files], readFile: async (p: string) => readFileSync(join(base, repo, p), "utf8") },
      migrations,
    );
    console.log(repo, open);
  }
});
