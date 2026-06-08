/**
 * @shipfix/analyzer — the deterministic RepoContext builder.
 *
 * Given a read-only view of a repository ({@link RepoSource}), it produces a
 * validated {@link RepoContext}: services, package managers, frameworks, env
 * references (names only), hardcoded-localhost smells, data needs, and the
 * monorepo signal. No LLM, no code execution — pure static analysis.
 */
export { analyzeRepo, type AnalyzeInput } from "./analyze";
export {
  createLocalFsRepoSource,
  repoSourceFromSandbox,
  type RepoSource,
  type SandboxLike,
} from "./source";
