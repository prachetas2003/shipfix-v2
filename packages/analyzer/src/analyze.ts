import { RepoContext } from "@shipfix/contracts";
import type { RepoSource } from "./source";
import { detectServices } from "./services";
import { detectMonorepoTool } from "./monorepo";
import { detectEnvAndUrls } from "./env";
import { detectDataNeeds } from "./data";

export interface AnalyzeInput {
  repoFullName: string;
  commitSha: string;
}

/** Hard cap so a pathological repo can't produce an unbounded file tree. */
const MAX_FILE_TREE = 5000;

/**
 * Deterministic static analysis: read-only inspection of a repository that
 * produces a {@link RepoContext}. This is the planner's ONLY input.
 *
 * Pure and side-effect free beyond reads through {@link RepoSource} — it never
 * executes repository code. The returned value is validated against the
 * RepoContext schema, so callers can trust its shape.
 */
export async function analyzeRepo(
  source: RepoSource,
  input: AnalyzeInput,
): Promise<RepoContext> {
  const fileList = await source.listFiles();
  const files = new Set(fileList);

  const services = await detectServices(source, files);
  const serviceRoots = services.map((s) => s.rootDir);

  const monorepoTool = detectMonorepoTool(files);
  const { envRefs, hardcodedUrls } = await detectEnvAndUrls(source, files, serviceRoots);
  const dataNeeds = await detectDataNeeds(source, files, envRefs);

  const fileTree = fileList.slice(0, MAX_FILE_TREE);

  return RepoContext.parse({
    repoFullName: input.repoFullName,
    commitSha: input.commitSha,
    fileTree,
    services,
    dataNeeds,
    envRefs,
    hardcodedUrls,
    monorepoTool,
  });
}
