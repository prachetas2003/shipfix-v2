# ShipFix v2

> ShipFix reliably deploys a defined class of full-stack apps — Next.js App
> Router/SSR and Vite/static frontends on Vercel, Express/Fastify Node APIs on
> Render, Neon Postgres — wires them together (including monorepos like
> `apps/web` + `apps/api`), runs Prisma migrations when needed, and verifies
> they are actually live before saying so. Repos outside that slice get a
> precise, honest diagnosis (what's blocking, what to do next) before any
> provider resource is touched.

The supported slice is planned **deterministically** from static repo evidence
(no model in the loop); anything else goes through an LLM proposal that a
deterministic validator gates. ShipFix never marks an app live unless
verification proves it. See [`docs/e2e-manual-test.md`](docs/e2e-manual-test.md)
for the live E2E checklist.

**Product roadmap (Phases A–C):** see
[`docs/implementation-guide-phases-abc.md`](docs/implementation-guide-phases-abc.md)
(addictive Next+API+Neon path, daily utility, differentiation). Task checklist:
[`docs/phases-abc-checklist.md`](docs/phases-abc-checklist.md).

## Architecture (spine)

```
apps/
  web        Next.js product shell (UI lands here)
  api        Fastify control plane (auth, projects, runs, stream gateway)
  worker     Temporal worker host (drives the deployment workflow)
packages/
  contracts      Zod schemas + types: RepoContext, DeploymentPlan, run events
  db             Drizzle (Postgres) schema + typed client
  workflow       Temporal workflow + activities (the state machine)
  sandbox        Sandbox interface (ONLY place untrusted repo code may run)
  analyzer       Deterministic RepoContext builder (static analysis)
  llm            LLM gateway (structured output + hard redaction wall)
  planner        RepoContext -> AI-proposed DeploymentPlan
  validator      Deterministic plan validation (the trust boundary)
  provisioner    Managed-service provisioning (Neon Postgres)
  secrets        Redaction + AES-256-GCM envelope-encryption vault
  observability  Run event logger interface
  adapters/core  ProviderAdapter interface
  adapters/render  Render web-service adapter (node_api only)
  adapters/vercel  Vercel static frontend adapter (frontend_static only)
  verifier       Plan-driven HTTP verification (backend, frontend, CORS)
```

**Hard rule:** untrusted repository code only ever executes through the
`@shipfix/sandbox` abstraction — never in the control plane (api/worker host).

## Prerequisites

- Node.js 20+
- pnpm 9 (`corepack enable && corepack prepare pnpm@9.15.4 --activate`)
- (for the worker) Temporal dev server: install the `temporal` CLI, then
  `temporal server start-dev`
- (later) Postgres for `@shipfix/db`

## Install

```bash
pnpm install
```

## Build / typecheck

```bash
pnpm build       # typechecks every package/app topologically
pnpm typecheck
```

## Run locally

```bash
pnpm dev:web     # Next.js shell        -> http://localhost:3000
pnpm dev:api     # Fastify control plane -> http://localhost:4000/health
# Worker needs a running Temporal dev server first:
temporal server start-dev
pnpm dev:worker  # registers workflows + activities on the effective task queue
```

## Verify the analyze-only slice (local end-to-end)

The first end-to-end vertical is **analyze_only**: repo URL → sandbox →
deterministic analyzer → validated `RepoContext` → redacted run events → SSE →
live web timeline. No AI planning, no deployment yet.

### 1. Prerequisites

- **Postgres** reachable at `DATABASE_URL`.
- **Temporal dev server** (`temporal` CLI installed).
- **git** on PATH (the dev sandbox shells out to it).
- A `.env` at the repo root (copy from `.env.example`). The API, worker, and
  Next.js web dev server load it automatically; real shell-exported env also
  works.

### 2. Create the schema (first run only)

```bash
pnpm --filter @shipfix/db db:migrate   # applies checked-in migrations to DATABASE_URL
# or for local throwaway databases:
pnpm --filter @shipfix/db db:push
```

If you see a database column error after pulling schema/auth changes, your local
database may be behind the current schema. Run `pnpm --filter @shipfix/db
db:push` for a local dev database, then restart `pnpm dev:api`.

### 2b. Authentication

Normal product auth uses Clerk. Configure the web app with the public key and
the API with the secret key:

```bash
AUTH_MODE=clerk
NEXT_PUBLIC_AUTH_MODE=clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
SHIPFIX_ADMIN_TOKEN=replace-with-different-long-random-token
```

Recommended local file layout:

| File | Read by | Put here |
| --- | --- | --- |
| Repo-root `.env` | API, worker, web dev server | Shared local config: `DATABASE_URL`, `AUTH_MODE`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, provider/LLM keys |
| `apps/api/.env.local` | API only | Optional API-only overrides |
| `apps/worker/.env.local` | Worker only | Optional worker-only overrides for Temporal, provider, and LLM settings |
| `apps/web/.env.local` | Web only | Optional web-only overrides; only use `NEXT_PUBLIC_*` values |

After changing Clerk env vars, restart both `pnpm dev:api` and `pnpm dev:web`.
After changing **`DATABASE_URL`**, restart **API, worker, web, and Temporal** together.
Do not mix local Docker Postgres and Neon in one test session — old Temporal workflows may
still reference runs in a previous database. Compare startup logs or `GET /admin/config-check`
(`apiDbFingerprint.hostHash` must match the worker log) to confirm API and worker point at the
same control-plane database.
In local dev, the generic `TEMPORAL_TASK_QUEUE=shipfix` is automatically scoped
to the configured `DATABASE_URL` (for example `shipfix-abc123...`) so an old
worker on a different database cannot pick up new runs. If you set a custom
queue, set the same value for API and worker.
After changing LLM/provider env vars, restart `pnpm dev:worker`; plan/deploy
activities run in the worker, not the API process.

### 2c. Local alpha usage limits

ShipFix keeps rate limits enabled in every environment. Local/dev defaults are
higher so repeated alpha testing does not get blocked immediately:

```bash
ALPHA_MAX_DEPLOY_RUNS_PER_USER_PER_DAY=50
ALPHA_MAX_PLAN_ANALYZE_RUNS_PER_USER_PER_DAY=100
ALPHA_MAX_ACTIVE_DEPLOY_RUNS_PER_USER=3
ALPHA_MAX_LLM_CALLS_PER_RUN=10
ALPHA_MAX_LLM_CALLS_PER_USER_PER_DAY=200
ALPHA_RATE_LIMIT_WINDOW_MS=60000
ALPHA_MAX_RUN_STARTS_PER_IP_WINDOW=100
LLM_MAX_PROMPT_CHARS=120000
```

Production keeps conservative built-in defaults unless explicit env vars are
set. Rate-limit errors include the specific limit code, such as
`daily_run_limit`, `active_deploy_limit`, `ip_run_start_limit`,
`llm_run_limit`, or `llm_daily_user_limit`. In local dev, increase the
`ALPHA_*` limits in `.env` and restart the API/worker.

For local development only, you may set `AUTH_MODE=dev` and
`NEXT_PUBLIC_AUTH_MODE=dev`. The API rejects dev auth when `NODE_ENV=production`.
Do not put provider tokens, LLM keys, `SHIPFIX_ADMIN_TOKEN`,
`SHIPFIX_MASTER_KEY`, or database URLs in any `NEXT_PUBLIC_*` variable.

### 3. Start the four processes (separate terminals)

```bash
temporal server start-dev          # terminal 1  -> localhost:7233 + UI :8233
pnpm dev:api                       # terminal 2  -> http://localhost:4000/health
pnpm dev:worker                    # terminal 3  -> "connected to Temporal ... polling 'shipfix-...'"
pnpm dev:web                       # terminal 4  -> http://localhost:3000
```

### 4. Run it

Open <http://localhost:3000>, paste a **public** GitHub repo (`owner/repo` or a
full URL), and click **Analyze**. Or run the smoke test (drives the same real
spine and asserts success):

```bash
pnpm smoke                         # defaults to octocat/Hello-World
pnpm smoke tj/commander.js         # or any public repo
```

### Full-stack deploy E2E (manual, real providers)

See **[`docs/e2e-manual-test.md`](docs/e2e-manual-test.md)** for the complete checklist:
Neon + Render + Vercel credentials, test repo requirements, timeline events,
success/partial/failure outcomes, and DB debugging queries.

### What success looks like (analyze-only)

- **UI timeline** (in order): `queued` → `analyzing` → `repo_clone_started` →
  `repo_clone_completed` → `analysis_started` → one `service_detected` per
  service → `env_refs_detected` → `data_needs_detected` → `analysis_completed` →
  `succeeded`. The final **RepoContext JSON** renders below the timeline.
- **`pnpm smoke`** prints the timeline and ends with `SMOKE PASS ✓` (exit 0).
- **DB**: one `users` row (dev user, `github_id = 0`), one `projects` row, one
  `runs` row with `status = 'succeeded'` and a real `commit_sha`, and a
  contiguous `run_events` timeline (`seq` 0..N, the last `analysis_completed`
  event's `data.repoContext` holds the full result).

### Failure cases (all produce understandable output)

| Case | What you'll see |
| --- | --- |
| Invalid repo (`not-a-repo`) | API `400 missing_repo` (no run created) |
| Repo missing/private (no App) | run `failed`; clone failure — install the ShipFix GitHub App for private repos, or confirm the public name |
| **Temporal not running** | API `503 workflow_start_failed`; run marked `failed` with an actionable event (no orphaned `queued` run) |
| **Postgres not configured** | API fails fast at boot (missing `DATABASE_URL`) or returns `500` with the connection error; worker logs a `DATABASE_URL is not set` warning |
| Analyzer error | run `failed`; `analysis_failed` event with the redacted error |

> The dev sandbox (`@shipfix/sandbox/dev`) runs the clone/analysis **on the host**
> and is **DEV ONLY** — it provides none of the isolation guarantees the
> `SandboxProvider` contract requires, and it throws if `NODE_ENV=production`.
> The production E2B sandbox replaces it behind the same interface.

Run the analyzer's unit tests (7 fixture repos):

```bash
pnpm --filter @shipfix/analyzer test
```

## Plan & deploy slices

Two more flows build on the same spine. Both need the worker's LLM gateway
configured (`LLM_PROVIDER`, a provider-specific backend key such as
`OPENAI_API_KEY`, and `LLM_MODEL` in the repo-root `.env` or
`apps/worker/.env.local`) — there is no mock planner. If planning fails with
“Planner setup is missing,” restart `pnpm dev:worker` after setting those vars.
Older local env files that use `LLM_API_KEY` still work as a fallback, but the
preferred names are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`
because ShipFix can diagnose missing provider config more clearly.

- **Generate plan** (`POST /runs/plan`): repo → RepoContext → AI-proposed
  `DeploymentPlan` → **deterministic validation** → persisted plan + run events →
  the UI renders the proposed service graph, managed services, wiring, questions,
  blockers, classification, and confidence. AI proposes; the validator disposes
  and downgrades. With no deploy adapters, plans honestly end as `diagnose_only`.

- **Deploy** (`POST /runs/deploy`): validated plan → **Neon provisioning** (when
  needed) → **Render `node_api` backend** → **`generated_from_service` env
  resolution** → **Vercel `frontend_static` deploy** → **plan-driven
  verification** (backend health, frontend loads, CORS/wiring) → honest terminal
  outcome.

  Connect provider credentials first (the **Connect provider** panel in the UI,
  or `POST /provider-accounts`):

  | Provider | Credential | Used for |
  | --- | --- | --- |
  | **Neon** | API key + backend `NEON_ORG_ID` | Provisioning managed Postgres; connection string sealed in `deployed_resources` |
  | **Render** | API key (+ optional `ownerId`) | Deploying `node_api` web services from the repo |
  | **Vercel** | API token (+ optional `teamId`) | Deploying `frontend_static` from the repo with build-time env wired from backend URL |

  Set `NEON_ORG_ID` in the repo-root `.env` (or the worker runtime
  environment) and restart the API/worker before deploying apps that provision
  Postgres. ShipFix treats Neon as not ready if the API key is connected but the
  organization id is missing.

  Requires `SHIPFIX_MASTER_KEY` (base64 32-byte key; `openssl rand -base64 32`)
  for the envelope-encryption vault. Provider API keys and database connection
  strings are sealed at rest; the worker decrypts just-in-time inside activities
  and **never** streams secret values to run events, logs, plans, UI, or LLM
  prompts. Backend public URLs are non-secret and may appear in events.

  **Deploy pipeline (worker):**

  ```
  provisionManagedServices → deployBackendServices → deployFrontendServices
    → verifyDeployedPlan → finalizeDeployRun
  ```

  **`generated_from_service` wiring** resolves generically from plan refs
  (`serviceId.publicUrl` / `serviceId.origin`) against `deployed_resources.url`
  — never from env var names.

  **Terminal outcomes (honest):**

  | Outcome | When |
  | --- | --- |
  | `succeeded` (backend-only plan) | Backend deployed **and** plan verification checks passed |
  | `succeeded` (full-stack plan) | Backend + frontend deployed **and** all `plan.verification` checks passed (health, frontend_loads, cors_from) |
  | `diagnosed` | Useful infrastructure is live (URLs, provisioned DB) but full app not proven — e.g. `cors_from` or other verification check failed, frontend skipped, or unsupported services remain |
  | `failed` | A service deploy was attempted and failed, or the run produced no live services and no provisioned resources |

  **What is NOT deployed yet:** Railway as a deploy target, Drizzle migrate
  execution, CORS auto-fix of repo source, or user-secret env resolution via
  HITL UI. ShipFix wires CORS origins after the frontend is live (Render setEnv)
  and verifies CORS evidence; it does not mutate repos to fix CORS code.

  **Staging smoke before alpha launch:**

  ```bash
  pnpm smoke:alpha -- --api http://localhost:4000 --repo owner/vite-express-demo --mode deploy
  ```

  The smoke script checks protected admin config, starts a real run with a Clerk
  session token, waits for a terminal state, and fails unless ShipFix proves the
  expected deployment state through verification evidence.

## Status

**Implemented end-to-end** (API → Temporal → sandbox/analyzer → LLM planner →
validator → provisioner → Render + Vercel adapters → plan-driven verifier →
run_events → SSE → UI):

- `analyze_only` — deterministic RepoContext (public, or private via GitHub App)
- `plan` — AI-proposed `DeploymentPlan` with deterministic validation
- `deploy` — Neon provisioning, sealed managed env, Render backend, Vercel
  frontend with `generated_from_service` wiring, plan-driven verification,
  honest partial/full/failed outcomes
- Push auto-deploy — `POST /webhooks/github` + per-project `autoDeployOnPush`
  (still gated + verified)

Secrets use a real AES-256-GCM envelope vault (local master key; KMS-swappable).
Provider credentials and `DATABASE_URL` are sealed at rest and opened only inside
trusted worker activities.

**Still intentionally unimplemented:** Railway adapter, KMS-backed vault, the
production E2B sandbox, and a full GitHub App install/OAuth UI (credentials are
env-based; private clone + push webhooks work when the App is installed).
