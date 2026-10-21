import type { PlanService } from "@shipfix/contracts";

/** Read-only view of the repo (same shape as the analyzer's RepoSource). */
export interface RepoFiles {
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<string | null>;
}

/** A whole-file replacement; `before` is null when the file is new. */
export interface FileEdit {
  path: string;
  before: string | null;
  after: string;
}

/** A change to the deployment plan rather than the repo; needs no pull request. */
export type PlanEdit =
  | { serviceId: string; field: "install" | "build" | "start"; from: string | null; to: string }
  | { serviceId: string; env: { name: string; value: string } };

export interface Fix {
  id: FixId;
  title: string;
  /** Plain English, written for the pull request body and the UI. */
  explanation: string;
  files: FileEdit[];
  plan: PlanEdit[];
}

export type FixId =
  | "import-path-case"
  | "port-binding"
  | "prisma-generate"
  | "node-engines"
  | "missing-dependency"
  | "lockfile-install"
  | "legacy-peer-deps"
  | "build-memory"
  | "missing-script"
  | "localhost-api-url"
  | "cors-origin"
  | "spa-fallback";

export type FixService = Pick<PlanService, "id" | "type" | "provider" | "rootDir" | "install" | "build" | "start">;

export interface FixContext {
  files: RepoFiles;
  service: FixService;
  /** Used only to look up a package's latest version on the npm registry. */
  fetchImpl?: typeof fetch;
}
