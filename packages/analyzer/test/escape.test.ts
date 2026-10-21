import { describe, expect, it } from "vitest";
import { analyzeRepo } from "../src/index";

function repo(files: Record<string, string>) {
  return {
    listFiles: async () => Object.keys(files),
    readFile: async (path: string) => files[path] ?? null,
  };
}

async function scan(files: Record<string, string>) {
  return analyzeRepo(repo(files), { repoFullName: "t/t", commitSha: "0".repeat(40) });
}

describe("escape hatch", () => {
  it("leaves a normal app alone", async () => {
    const ctx = await scan({
      "package.json": JSON.stringify({ dependencies: { next: "15.0.0" } }),
      "app/page.tsx": "export default function Page() { return null }",
    });
    expect(ctx.escape).toBeUndefined();
  });

  it("plans a Lovable app with schema in the repo and rows left on Lovable Cloud", async () => {
    const ctx = await scan({
      "package.json": JSON.stringify({ devDependencies: { "lovable-tagger": "1.0.0" }, dependencies: { "@supabase/supabase-js": "2.0.0" } }),
      "supabase/migrations/20240101000000_init.sql": "create table public.notes (id int);",
      "src/App.tsx": "export const App = () => null",
    });
    expect(ctx.escape?.source).toBe("lovable");
    expect(ctx.escape?.platform).toBe("Lovable Cloud");
    const moves = Object.fromEntries((ctx.escape?.moves ?? []).map((move) => [move.id, move.automatic]));
    expect(moves.code).toBe(true);
    expect(moves.schema).toBe(true);
    expect(moves.secrets).toBe(false);
    expect(moves.rows).toBe(false);
    expect(moves.auth).toBe(false);
    expect(JSON.stringify(ctx.escape)).not.toMatch(/postgres:\/\//);
  });

  it("prefers Lovable when a repo also has a Replit file", async () => {
    const ctx = await scan({
      "package.json": JSON.stringify({ dependencies: { "lovable-tagger": "1.0.0" } }),
      ".replit": "run = \"npm start\"",
    });
    expect(ctx.escape?.source).toBe("lovable");
  });

  it("recognizes Replit and Bolt from their project files", async () => {
    const replit = await scan({ ".replit": "run = \"npm start\"" });
    expect(replit.escape?.source).toBe("replit");
    expect(replit.escape?.moves.some((move) => move.id === "schema")).toBe(false);

    const bolt = await scan({ "README.md": "Built on bolt.new" });
    expect(bolt.escape?.source).toBe("bolt");
  });
});
