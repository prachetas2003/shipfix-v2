/**
 * @shipfix/eval — the reliability harness.
 *
 * Runs a corpus of real repositories through the same analyze -> plan ->
 * validate pipeline the worker uses and reports how many ShipFix would deploy,
 * how fast, and what blocks the rest. Live mode drives real deploys through
 * the API to measure first-try live rate and time to live.
 */
export { Corpus, CorpusEntry, entryId, loadCorpus, mergeCorpus, pruneNonApps } from "./corpus";
export { shallowClone, type ClonedRepo, type CloneOptions } from "./clone";
export {
  FULL_CAPABILITIES,
  evaluateCorpus,
  evaluateEntry,
  shapeOf,
  type EvalPlanSource,
  type EvalStatus,
  type EvaluateOptions,
  type RepoEvalResult,
  type RepoShape,
} from "./evaluate";
export {
  FIRST_TRY_TARGET,
  findRegressions,
  renderMarkdown,
  shapeSignature,
  summarize,
  type EvalReport,
  type EvalSummary,
  type Regression,
} from "./report";
export { DISCOVERY_QUERIES, discoverRepos, type DiscoverOptions } from "./discover";
export {
  driveLiveRun,
  summarizeLive,
  type LiveOptions,
  type LiveOutcome,
  type LiveRunResult,
  type LiveSummary,
} from "./live";
