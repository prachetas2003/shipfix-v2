import type { RepoContext } from "@shipfix/contracts";

type MonorepoTool = RepoContext["monorepoTool"];

/**
 * Detect the monorepo orchestration tool from root-level marker files.
 *
 * Priority is by specificity: a turbo/nx config is a stronger, more actionable
 * signal than a bare pnpm workspace. The RepoContext enum only models tools we
 * can reason about (npm/yarn `workspaces` collapses to "none").
 */
export function detectMonorepoTool(files: ReadonlySet<string>): MonorepoTool {
  if (files.has("turbo.json")) return "turbo";
  if (files.has("nx.json")) return "nx";
  if (files.has("pnpm-workspace.yaml")) return "pnpm_workspace";
  return "none";
}
