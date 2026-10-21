/**
 * Public deploy-error pages.
 * Corpus counts are the 323 cloned Lovable, Bolt, v0, Cursor, and Replit repos
 * in eval-offline-2026-10-18T05-10-16-545Z. Log pages are the failures
 * diagnoseLogs names; that run did not deploy, so they have no count.
 */

export type ErrorSource = "corpus" | "logs";

export interface DeployError {
  slug: string;
  title: string;
  /** One sentence a person can scan on the index. */
  summary: string;
  whatHappened: string;
  whatShipFixDoes: string;
  source: ErrorSource;
  /** Repos in the public corpus whose plan carried this issue. */
  corpusCount?: number;
}

const SANDBOX_FIX =
  "ShipFix tries a fix, rebuilds it in a sandbox, and opens one pull request when that build passes. Your default branch stays as it is until you merge.";

const ASK_SECRET =
  "ShipFix names the missing value and waits for you to enter it. The value is sealed and is not sent to the model.";

export const deployErrors: DeployError[] = [
  {
    slug: "missing-secret",
    title: "A secret is required before deploy",
    summary: "The plan is ready except for a value only you know.",
    whatHappened:
      "The app reads an environment variable that looks like a secret, and the repo does not contain a safe value for it. ShipFix will not invent one.",
    whatShipFixDoes: ASK_SECRET,
    source: "corpus",
    corpusCount: 118,
  },
  {
    slug: "unknown-provider-project",
    title: "ShipFix cannot tell which provider project to use",
    summary: "The app talks to Supabase or a similar host, and the project ref is not in the repo.",
    whatHappened:
      "The planner found an integration but not which project it belongs to. Deploying against the wrong project would point the app at someone else's data.",
    whatShipFixDoes: "ShipFix asks which project to use, then continues the deploy with that answer.",
    source: "corpus",
    corpusCount: 25,
  },
  {
    slug: "missing-health-check",
    title: "The API has no health route ShipFix can check",
    summary: "A backend can start and still be the wrong process. ShipFix wants a route that returns success.",
    whatHappened:
      "The plan includes a Node or Python API, and the analyzer could not find a health path in the routes. Without that path, a green deploy would only mean the process started.",
    whatShipFixDoes:
      "ShipFix keeps the plan in setup until a health route can be checked, so a finished deploy means the API answered.",
    source: "corpus",
    corpusCount: 6,
  },
  {
    slug: "missing-package",
    title: "A package is missing",
    summary: "The build cannot find a module the code imports.",
    whatHappened: "The code imports a package that is not listed in package.json, so the host never installed it.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "import-path-case",
    title: "An import points at a file that is not there",
    summary: "The path works on a laptop and fails on the host.",
    whatHappened:
      "The code imports a local file that does not exist on the server. macOS and Windows ignore letter case in file names. Linux does not.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "missing-script",
    title: "package.json has no script for the command",
    summary: "The host runs npm run start or build, and that script is missing.",
    whatHappened: "The start or build command names a package.json script that is not defined.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "lockfile-out-of-date",
    title: "The lockfile does not match package.json",
    summary: "A frozen install stops because the lockfile is stale.",
    whatHappened: "package.json and the lockfile disagree, so the clean install the host runs refuses to continue.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "dependency-conflict",
    title: "Two packages want incompatible versions",
    summary: "npm stops on a peer dependency conflict.",
    whatHappened: "Two packages ask for incompatible versions of the same dependency, so the install stops.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "wrong-node-version",
    title: "The app needs a different Node.js version",
    summary: "The host's Node is older or newer than the engines field.",
    whatHappened: "The app or one of its packages needs a different Node.js version than the host used.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "typescript-error",
    title: "TypeScript errors stop the build",
    summary: "The production build typechecks. The dev server often does not.",
    whatHappened: "The build runs a strict type check and the code has type errors.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "syntax-error",
    title: "A file does not parse",
    summary: "A syntax error stops the compile or the start command.",
    whatHappened: "A file has a syntax error, so it cannot be compiled or run.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "out-of-memory",
    title: "The build ran out of memory",
    summary: "The host killed the build after it passed the memory limit.",
    whatHappened: "The build used more memory than the plan allows and was stopped.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "port-not-listening",
    title: "The server is not listening on the host port",
    summary: "The process starts, then the host finds no open port.",
    whatHappened: "The host waits for the app on the PORT variable, but the app listens on a fixed port or never starts a server.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "missing-setting",
    title: "A required setting is missing at startup",
    summary: "The process exits because an environment variable is unset.",
    whatHappened: "The app needs an environment variable when it starts, and that variable is not set on the host.",
    whatShipFixDoes: ASK_SECRET,
    source: "logs",
  },
  {
    slug: "localhost-url",
    title: "The app calls localhost",
    summary: "A request goes to 127.0.0.1, which is the host machine, not the other service.",
    whatHappened: "The app tries to reach a service on localhost. That address only exists on the machine where the app was built.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "database-unreachable",
    title: "The app cannot reach its database",
    summary: "The connection string still points at a laptop database.",
    whatHappened: "The app is using a database on localhost, or another address the host cannot reach, instead of the database ShipFix provisioned.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "prisma-client",
    title: "Prisma Client was never generated",
    summary: "The app imports Prisma, and prisma generate did not run in the build.",
    whatHappened: "The app uses Prisma, but the client was not generated during the build.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "python-install-failed",
    title: "Python packages failed to install",
    summary: "pip cannot find a version, or a package needs system libraries.",
    whatHappened: "pip could not install the requirements. The version may not exist, or the package may need libraries the host image does not have.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "python-module-missing",
    title: "A Python module is missing",
    summary: "The process starts, then Python raises ModuleNotFoundError.",
    whatHappened: "The app imports a module that is not in the requirements or is not on the import path.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
  {
    slug: "command-not-found",
    title: "A command is not installed",
    summary: "The build or start script calls a tool the host does not have.",
    whatHappened: "The command runs a tool that is not installed on the host. It is often a dev dependency that the production install skipped.",
    whatShipFixDoes: SANDBOX_FIX,
    source: "logs",
  },
];

export function deployErrorBySlug(slug: string): DeployError | undefined {
  return deployErrors.find((error) => error.slug === slug);
}

export const CORPUS_REPO_COUNT = 323;
