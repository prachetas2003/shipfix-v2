# Manual E2E test — full deploy loop

This guide walks through proving the **first real ShipFix loop** as a user would:
public Vite frontend + Node/Express backend + Postgres → Neon → Render → Vercel →
`generated_from_service` wiring → plan-driven verification → honest terminal outcome.

No mocks, no fake providers. You need real API keys and real cloud accounts.

**Out of scope for this test:** recovery, migrations, private repos, GitHub App auth,
production E2B sandbox, new providers.

---

## What you are proving

```
Analyze (in deploy run) → Plan → Validate
  → Neon Postgres (if planned)
  → Render node_api backend (DATABASE_URL from sealed Neon row)
  → Vercel frontend_static (build env from api.publicUrl via generated_from_service)
  → verifyDeployedPlan (health_path, frontend_loads, cors_from if in plan)
  → succeeded | diagnosed | failed
```

---

## 1. Required environment variables

Copy `.env.example` to `.env` at the repo root and fill in every **required** value.

| Variable | Required for E2E | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Yes | ShipFix control-plane Postgres (not Neon). API + worker both read this. |
| `SHIPFIX_MASTER_KEY` | Yes | Base64 32-byte key. Generate: `openssl rand -base64 32`. Seals provider creds + Neon connection strings. |
| `LLM_PROVIDER` | Yes | `anthropic` or `gemini`. Deploy runs include AI planning — no mock fallback. |
| `LLM_API_KEY` | Yes | Key for the chosen provider. |
| `LLM_MODEL` | Yes | e.g. `claude-3-5-sonnet-latest` or `gemini-1.5-pro`. |
| `TEMPORAL_ADDRESS` | Yes | Default `localhost:7233` with Temporal dev server. |
| `TEMPORAL_NAMESPACE` | Yes | Default `default`. |
| `TEMPORAL_TASK_QUEUE` | Yes | Default `shipfix`. |
| `API_PORT` | Optional | Default `4000`. |
| `WEB_ORIGIN` | Optional | Default `*` for local dev CORS/SSE. |
| `NEXT_PUBLIC_API_URL` | Yes (web) | Default `http://localhost:4000`. Browser → API. |

Provider credentials are **not** env vars — connect them in the UI (sealed into `provider_accounts`).

---

## 2. Required local services

| Service | Purpose | How to run |
| --- | --- | --- |
| **Postgres** | Control-plane DB (`runs`, `run_events`, `plans`, `deployed_resources`) | Docker, local install, or hosted dev instance reachable at `DATABASE_URL` |
| **Temporal dev server** | Durable workflow orchestration | `temporal server start-dev` → UI at http://localhost:8233 |
| **git** | Clone public repos during analyze | On PATH (worker uses dev sandbox) |

You do **not** run Neon, Render, or Vercel locally — those are real cloud APIs.

---

## 3. Required provider credentials

Connect all three before clicking **Deploy** on a full-stack repo.

| Provider | UI field | Stored as | Used for |
| --- | --- | --- | --- |
| **Neon** | API key | `{ apiKey }` | Provision Postgres; connection string sealed in `deployed_resources` |
| **Render** | API key | `{ apiKey }` | Deploy `node_api` web service from GitHub repo |
| **Vercel** | API token | `{ apiToken }` | Deploy `frontend_static` from GitHub repo |

**Account prerequisites (real, not faked by ShipFix):**

- **Neon:** API key from [Neon console](https://console.neon.tech) → Account settings → API keys.
- **Render:** API key from Render dashboard → Account settings. Optional `ownerId` if create fails (API: `GET /owners` usually resolves it). For team accounts, ensure the key can create web services.
- **Vercel:** Personal or team token from Vercel → Settings → Tokens. Your Vercel account must have **GitHub connected** and permission to import/deploy the **public** test repo. For team projects, connect via API instead of UI:

  ```bash
  curl -X POST http://localhost:4000/provider-accounts \
    -H "Content-Type: application/json" \
    -d '{"provider":"vercel","values":{"apiToken":"YOUR_TOKEN","teamId":"team_xxx"}}'
  ```

Verify capabilities:

```bash
curl http://localhost:4000/providers
```

Expect:

```json
{
  "connected": ["neon", "render", "vercel"],
  "provisionable": ["neon"],
  "deployable": ["render", "vercel"],
  "deployableServiceTypes": {
    "render": ["node_api"],
    "vercel": ["frontend_static"]
  }
}
```

---

## 4. Commands to start ShipFix locally

One-time setup:

```bash
corepack enable && corepack prepare pnpm@9.15.4 --activate
pnpm install
cp .env.example .env
# Edit .env — fill DATABASE_URL, SHIPFIX_MASTER_KEY, LLM_*
pnpm db:push
```

Four terminals (keep all running):

```bash
# Terminal 1 — Temporal
temporal server start-dev

# Terminal 2 — API
pnpm dev:api
# → http://localhost:4000/health should return OK

# Terminal 3 — Worker
pnpm dev:worker
# → log should show polling task queue "shipfix"

# Terminal 4 — Web UI
pnpm dev:web
# → http://localhost:3000
```

Quick sanity before E2E:

```bash
curl http://localhost:4000/health
curl http://localhost:4000/providers
```

Optional analyze-only smoke (no LLM, no deploy):

```bash
pnpm smoke
# Uses octocat/Hello-World by default — NOT a full-stack deploy target
```

---

## 5. Test repo requirements

The target repo must be **public on GitHub** and match what the analyzer + planner expect.

### Layout (monorepo recommended)

```
repo/
  apps/web/          # Vite frontend
    package.json     # scripts: build (e.g. vite build)
    src/...          # uses import.meta.env.VITE_API_URL
  apps/api/          # Express (or similar) backend
    package.json     # scripts: build, start
    src/index.ts     # GET /health → 200, uses process.env.DATABASE_URL
```

### Backend (`apps/api`)

- [ ] **`GET /health`** (or path the plan uses) returns **HTTP 200** when DB is reachable (or even without DB — but app must listen).
- [ ] Reads **`DATABASE_URL`** from env (analyzer detects this).
- [ ] **`npm run build`** and **`npm run start`** exist (or equivalent in plan).
- [ ] **CORS:** for full-stack **success** when the plan includes `cors_from`, the backend must respond with `Access-Control-Allow-Origin` matching the Vercel frontend origin (or `*`). ShipFix does **not** fix CORS for you.

### Frontend (`apps/web`)

- [ ] Vite (or static build) with **`VITE_API_URL`** referenced in source.
- [ ] **`npm run build`** produces static output (e.g. `dist/`).
- [ ] No server-side secrets in the repo.

### Git / deploy access

- [ ] Repo is **public** (`owner/repo` format).
- [ ] Default branch is **`main`** (or update `projects.default_branch` in DB if using another branch).
- [ ] **Render** account can deploy from this GitHub repo.
- [ ] **Vercel** account can import/deploy this GitHub repo (GitHub app installed).

### Reference shape (local fixtures only)

The analyzer fixtures under `packages/analyzer/test/fixtures/` show the expected
structure (e.g. `pnpm-workspace/packages/api` with `/health`). They are **not**
GitHub repos — use your own public repo with the same shape.

---

## Recommended minimal test repo

The smallest public repo that exercises the full supported path. **ShipFix does not
ship this repo** — create or fork one matching this spec before the live E2E.

### Directory layout

```
your-e2e-repo/                 # public GitHub repo, default branch main
  README.md
  apps/
    api/
      package.json
      tsconfig.json
      src/
        index.ts               # Express entrypoint
    web/
      package.json
      vite.config.ts
      index.html
      src/
        main.tsx               # references import.meta.env.VITE_API_URL
```

A root `package.json` is optional. ShipFix plans per-service `rootDir` (`apps/api`,
`apps/web`); each app must have its own `package.json` with the scripts below.

### `apps/api` — Express backend

**Purpose:** Render `node_api` deploy, Neon `DATABASE_URL`, `/health` verification.

**Minimal `package.json` scripts** (names matter — validator grounds plans against these):

```json
{
  "name": "e2e-api",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "express": "^4.21.0",
    "cors": "^2.8.5"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/express": "^4.17.21",
    "@types/cors": "^2.8.17"
  }
}
```

**Minimal `src/index.ts` behavior:**

- Listen on `process.env.PORT` (Render injects `PORT`).
- **`process.env.DATABASE_URL`** referenced in source so the analyzer detects Postgres
  (connection optional for `/health` — health can return 200 even if DB connect is lazy).
- **`GET /health`** → HTTP 200 + JSON body (e.g. `{ ok: true }`).
- **CORS** — see [CORS variants](#cors-variants-succeeded-vs-diagnosed) below.

Example shape (not a copy-paste requirement):

```typescript
import express from "express";
import cors from "cors";

const app = express();
const port = Number(process.env.PORT) || 3000;

// Analyzer detects Postgres need from this reference
const databaseUrl = process.env.DATABASE_URL;

app.use(cors({ origin: true })); // omit entirely for “diagnosed” CORS test

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, dbConfigured: Boolean(databaseUrl) });
});

app.listen(port);
```

**`tsconfig.json`:** emit to `dist/` so `npm run start` works after `npm run build`.

### `apps/web` — Vite frontend

**Purpose:** Vercel `frontend_static` deploy, `VITE_API_URL` wired from backend URL at build time.

**Minimal `package.json` scripts:**

```json
{
  "name": "e2e-web",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "vite": "^5.4.0",
    "@vitejs/plugin-react": "^4.3.0"
  }
}
```

**`src/main.tsx`** must reference the env var (analyzer + planner look for this):

```typescript
const apiUrl = import.meta.env.VITE_API_URL;
// use apiUrl in fetch/UI so the wiring is real, not dead code
```

**`vite.config.ts`:** standard Vite + React plugin; default `outDir` is `dist` (matches
typical planner `outputDir`).

No `VITE_API_URL` value in repo — ShipFix injects it at Vercel deploy time via
`generated_from_service` → `api.publicUrl`.

### CORS variants (succeeded vs diagnosed)

The LLM planner **may** include a `cors_from` verification check. Behavior depends on
what you commit:

| Goal | Backend CORS | Expected terminal outcome (if deploys succeed) |
| --- | --- | --- |
| **Test full-stack `succeeded`** | Enable CORS (`cors({ origin: true })` or allow your Vercel origin) | `succeeded` when all plan checks pass including `cors_from` if present |
| **Test partial `diagnosed`** | **No** CORS middleware | `diagnosed` if plan includes `cors_from` and check fails — backend + frontend URLs still visible |

For a **first** E2E, pick one goal deliberately. Testing both is two commits or two repos.

`frontend_loads` and `health_path` can pass without CORS; **`cors_from` is the usual
split between succeeded and diagnosed** when the planner adds it.

### Scripts ShipFix expects (typical validated plan)

| Service | rootDir | install | build | start | outputDir | healthCheckPath |
| --- | --- | --- | --- | --- | --- | --- |
| `web` | `apps/web` | `npm install` | `npm run build` | — | `dist` | — |
| `api` | `apps/api` | `npm install` | `npm run build` | `npm run start` | — | `/health` |

Render runs install + build + start. Vercel runs install + build only. Script names
must exist in each app’s `package.json` or the validator downgrades the plan.

### What to commit to GitHub

| Commit | Why |
| --- | --- |
| All source under `apps/api` and `apps/web` | Render/Vercel build from git |
| Each app’s `package.json` | Script grounding + dependency install |
| Lockfile (`package-lock.json` or `pnpm-lock.yaml`) if you use one | Reproducible installs on providers |
| `tsconfig.json`, `vite.config.ts`, `index.html` | Build tooling |
| Root `README.md` | Documents the demo app |
| `.gitignore` | Standard Node ignores (see below) |

### What NOT to commit

| Never commit | Why |
| --- | --- |
| `.env`, `.env.local`, `.env.production` | Secrets and local overrides |
| `DATABASE_URL`, Neon connection strings, API keys, tokens | ShipFix + Neon/Render/Vercel inject these at deploy time |
| `VITE_API_URL` with a production URL baked in | Wired by ShipFix via `generated_from_service` |
| `node_modules/` | Provider installs on deploy |
| `dist/`, `build/` (optional) | Built on Render/Vercel; omitting avoids stale artifacts |
| `.vercel/`, Render-specific local state | Local CLI/metadata, not needed for git-based deploy |

ShipFix seals secrets in its **control plane** only. The **target repo stays free of
secrets** — that is what the E2E is proving.

### Pre-flight before pushing

- [ ] Repo is **public** on GitHub
- [ ] Default branch is **`main`**
- [ ] Local smoke: `cd apps/api && npm install && npm run build && npm run start` → `curl localhost:PORT/health` → 200
- [ ] Local smoke: `cd apps/web && npm install && npm run build` → `dist/` exists
- [ ] No secret files staged (`git status`)
- [ ] Your Render and Vercel accounts can access this repo (GitHub integration)

### Naming

Service ids in the plan (`web`, `api`, `db`) come from the **LLM planner**, not from
folder names. Folder names `apps/web` and `apps/api` are conventions that match what
the planner usually proposes for this layout — they do not have to be exact, but
deviating increases the chance of ungrounded `rootDir` or script mismatches.

---

## 6. Connect providers in the UI

1. Open http://localhost:3000
2. Find **Connect provider**
3. For each provider:
   - Select **Neon** → paste API key → **Connect**
   - Select **Render** → paste API key → **Connect**
   - Select **Vercel** → paste API token → **Connect**
4. Confirm footer shows: `connected: neon, render, vercel`

Credentials are encrypted immediately; they never appear in the timeline or plan JSON.

---

## 7. Buttons to click (recommended flow)

### Step A — Optional: inspect the plan first

1. Paste `owner/repo` (or full GitHub URL) in the repo field.
2. Click **Generate plan**.
3. Wait for timeline to finish (`succeeded` or `diagnosed`).
4. Review the plan panel:
   - Services: `web` (vercel, frontend_static), `api` (render, node_api), `db` (neon)
   - Wiring: `api.publicUrl` → `web.VITE_API_URL`, `db.connectionUrl` → `api.DATABASE_URL`
   - Classification should be **deployable** (green) if all providers connected.
   - Verification checks listed (at minimum `health_path` + `frontend_loads`; planner may add `cors_from`).

### Step B — Full deploy E2E

1. Same repo field (or a fresh run).
2. Click **Deploy** (not Analyze, not Generate plan only).
3. Watch the timeline until the run reaches a terminal status.

Deploy mode runs the **full pipeline** in one workflow: analyze → plan → validate → provision → backend deploy → frontend deploy → verify → finalize.

---

## 8. Timeline events to expect

Stages appear in order (individual log lines may vary). Look for these **`data.event`** values in the timeline:

| Phase | Stage | Key events |
| --- | --- | --- |
| Analyze | `analyzing` | `repo_clone_started` → `repo_clone_completed` → `analysis_started` → `service_detected` (×N) → `env_refs_detected` → `data_needs_detected` → `analysis_completed` |
| Plan | `planning` | `plan_generated` |
| Validate | `validating` | `plan_validated` (plan JSON in event data) |
| Provision | `provisioning` | `provision_started` → `provision_log` → `resource_provisioned` → `verification` (Neon `SELECT 1`) |
| Backend | `deploying` | `deploy_started` (render) → `deploy_log` → `service_deployed` (serviceRole: backend, publicUrl) |
| Frontend | `deploying` | `deploy_started` (vercel) → `deploy_log` → `service_deployed` (serviceRole: frontend, publicUrl) |
| Verify | `verifying` | `verification` per check (`health_path`, `frontend_loads`, `cors_from`, …) |
| Terminal | `succeeded` / `diagnosed` / `failed` | Final stage message |

**Skipped / blocked (partial path):**

- `deploy_needs_credential` — provider not connected
- `deploy_env_blocked` — env resolution failed (e.g. backend not live before frontend)
- `provision_needs_credential` — Neon not connected
- `deploy_failed` / `provision_failed` — real provider API error (detail in timeline, redacted)

---

## 9. What success looks like

### Full-stack success (`status: succeeded`)

All of the following:

- [ ] Plan includes backend + frontend with supported providers/types
- [ ] Neon DB row in **Deployed services** / provisioned resources (if planned)
- [ ] Render backend **service_deployed** with public URL
- [ ] Vercel frontend **service_deployed** with public URL
- [ ] Every **`plan.verification`** check shows `ok: true` in timeline
- [ ] UI banner: **“App deployed and verified”** with frontend + backend links
- [ ] No `diagnose_only` classification blocking deploy

### Backend-only success

If the plan has **no** Vercel frontend service:

- [ ] `status: succeeded`
- [ ] UI: **“Backend deployed and verified”** (not “app deployed”)

---

## 10. What partial success looks like (`status: diagnosed`)

Useful infrastructure is live, but the **full app is not proven working**.

Common cases:

| Situation | Terminal | UI |
| --- | --- | --- |
| Backend + frontend deployed, **`cors_from` failed** | `diagnosed` | Partial success banner; failed check named (e.g. `api.cors_from`); **both URLs still visible** |
| Backend + frontend deployed, other verification failed | `diagnosed` | Partial success; failed checks listed |
| Backend live, frontend **skipped** (no Vercel / env blocked) | `diagnosed` | “Frontend did not deploy — full-stack app is NOT live” |
| Plan includes **unsupported** services (SSR, Railway, …) | `diagnosed` | Deployed parts live; unsupported services called out |
| Only Neon provisioned, deploy skipped | `diagnosed` | Provisioned resources shown; no service URLs |

**Important:** `cors_from` failure is **`diagnosed`**, not `failed`, when deploys succeeded — so you still see live URLs and can fix CORS in the target repo manually.

---

## 11. What failure looks like (`status: failed`)

| Situation | Terminal |
| --- | --- |
| Render or Vercel **deploy attempted and failed** | `failed` — “Service deployment failed” |
| **Nothing** deployed and **nothing** provisioned | `failed` — no useful live result |
| Temporal / API / worker not running | Run may not start or stays `queued`; API 503 |

Verification failures alone do **not** produce `failed` when services are live (those are `diagnosed`).

UI banner: **“Deploy or verification failed. No success was claimed without live evidence.”** — primarily for deploy failures.

---

## 12. DB inspection when something goes wrong

Connect to control-plane Postgres (`DATABASE_URL` from `.env`).

### Latest run

```sql
SELECT id, status, mode, commit_sha, started_at, finished_at
FROM runs
ORDER BY started_at DESC
LIMIT 5;
```

### Event timeline (replace `RUN_ID`)

```sql
SELECT seq, stage, level, message, data->>'event' AS event, data
FROM run_events
WHERE run_id = 'RUN_ID'
ORDER BY seq;
```

### Validated plan

```sql
SELECT version, confidence, doc->>'classification' AS classification, doc
FROM plans
WHERE run_id = 'RUN_ID'
ORDER BY version DESC
LIMIT 1;
```

Look in `doc` for: `services`, `wiring`, `verification`, `deployOrder`.

### Deployed resources (URLs only — no secrets)

```sql
SELECT service_id, kind, provider, status, url, external_id, exposes_env,
       (enc_blob IS NOT NULL) AS has_sealed_secret
FROM deployed_resources
WHERE run_id = 'RUN_ID';
```

- `kind = 'managed_db'` / `service_id = 'db'` → Neon; secret in encrypted columns only
- `kind = 'service'`, `provider = 'render'` → backend URL in `url`
- `kind = 'service'`, `provider = 'vercel'` → frontend URL in `url`

### Provider connections (no plaintext keys)

```sql
SELECT provider, created_at FROM provider_accounts;
```

### Temporal UI

http://localhost:8233 — inspect workflow `deploymentWorkflow` for activity failures/retries.

---

## 13. Common expected problems

### Missing `/health` or wrong path

- **Symptom:** `verification` event for `health_path` → `ok: false`
- **Outcome:** `diagnosed` if deploys succeeded
- **Fix (in target repo):** Add `GET /health` returning 200, or align plan `healthCheckPath` / verification target

### Missing CORS

- **Symptom:** `verification` → `cors_from` → `ok: false`, “Missing Access-Control-Allow-Origin”
- **Outcome:** `diagnosed` — frontend + backend URLs still shown
- **Fix (in target repo):** e.g. `cors({ origin: true })` or allow Vercel origin. ShipFix will not patch the repo.

### Vercel Git access / import failure

- **Symptom:** `deploy_failed` on frontend; timeline detail mentions Vercel API / git / repo
- **Outcome:** `failed` if deploy failed; may be `diagnosed` if backend still live
- **Checks:** GitHub connected to Vercel; repo is public; token has deploy scope; team token needs `teamId` in credentials

### Render deploy failure

- **Symptom:** `deploy_failed` for `api`; Render build logs in `deploy_log` lines
- **Causes:** Wrong `rootDir`, missing build/start scripts, repo not accessible, free-tier limits, missing `ownerId`
- **Outcome:** `failed`

### Neon credential / provision failure

- **Symptom:** `provision_needs_credential` or `provision_failed`
- **Checks:** Neon API key connected; `SHIPFIX_MASTER_KEY` set; Neon account limits
- **Outcome:** Often `diagnosed` if backend/frontend never get DATABASE_URL wired

### `deploy_env_blocked` on frontend

- **Symptom:** Frontend skipped; issues include `missing_service` or `service_not_live`
- **Cause:** Backend did not reach `live` with a public URL before frontend deploy
- **Fix:** Resolve backend deploy first; check `deployed_resources.url` for `api`

### Plan downgraded to `diagnose_only`

- **Symptom:** `plan_downgraded`; classification red; deploy activities skip or partial
- **Cause:** Missing provider connection, validator fatal (ungrounded scripts, bad refs)
- **Fix:** Connect providers; use a repo that matches detected `rootDir` and npm scripts

### LLM / planning failure

- **Symptom:** Run fails during `planning`; no `plan_validated`
- **Fix:** Check `LLM_API_KEY`, `LLM_MODEL`, worker logs

### Temporal not running

- **Symptom:** API error starting run; `workflow_start_failed`
- **Fix:** `temporal server start-dev`; worker polling

### Private repo

- **Not supported.** Clone fails at analyze with a clear error. Use a **public** repo.

---

## E2E checklist (printable)

```
Setup
[ ] .env filled (DATABASE_URL, SHIPFIX_MASTER_KEY, LLM_*)
[ ] pnpm install && pnpm db:push
[ ] Postgres reachable
[ ] temporal server start-dev
[ ] pnpm dev:api / dev:worker / dev:web running
[ ] curl localhost:4000/health OK

Providers
[ ] Neon API key connected in UI
[ ] Render API key connected in UI
[ ] Vercel API token connected in UI
[ ] GET /providers shows all three connected + deployable types

Test repo
[ ] Public GitHub repo matching docs/e2e-manual-test.md § “Recommended minimal test repo”
[ ] apps/web (Vite) + apps/api (Express), scripts grounded, no secrets committed
[ ] Render + Vercel can access repo from your accounts

Run
[ ] (Optional) Generate plan — classification deployable, wiring looks correct
[ ] Deploy — timeline reaches terminal status
[ ] deployed_resources has db (if planned), api URL, web URL
[ ] Verification events match plan.verification

Outcome
[ ] succeeded — all checks passed, banner matches (backend-only vs full-stack)
[ ] diagnosed — live URLs visible, failed/skipped checks explained
[ ] failed — deploy failure identified in timeline + provider dashboards
```

---

## After E2E

Record for the team:

1. Repo URL used
2. Terminal `status` and final stage message
3. Public backend + frontend URLs
4. Which verification checks passed/failed
5. Any provider dashboard errors (Render build log, Vercel deployment, Neon project)

Do **not** proceed to recovery, migrations, or private-repo work until this loop is proven once with real credentials.
