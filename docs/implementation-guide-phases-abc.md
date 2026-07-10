# ShipFix Implementation Guide — Phases A, B, C

> **Audience:** any coding agent or engineer implementing the addictive primary path, daily utility, and differentiation depth.
> **Do not implement Phase D** (Railway as identity, Hono/Nest expansion, custom compute, multi-env staging teams, etc.) until A–C are done.
> **Do not rewrite the architecture.** Extend the existing spine.

---

## 0. Product north star (read before coding)

ShipFix is a **deployment operator**, not a PaaS.

**Primary addictive path (must work end-to-end):**

```
pnpm monorepo
  apps/web  → Next.js App Router (SSR) → Vercel (frontend_ssr)
  apps/api  → Express or Fastify       → Render (node_api)
  Postgres  → Neon                     → provision + migrate + wire
```

Then **prove** live:

- frontend loads
- backend health passes
- frontend can reach backend (CORS)
- backend can reach database
- migration state is valid (Prisma first)

**Secondary paths (keep working, do not remove):**

- Vite/React SPA + Express/Fastify + Neon (`golden-fullstack`)
- Standalone Next.js on Vercel (`golden-next`)

**Differentiation:** never claim “live” unless verification proves it; otherwise precise diagnosis.

**Borrow Railway’s product shape, not its infrastructure:**

- app dashboard, service graph, env/secrets, history, status, redeploy, health, later GitHub push
- do **not** build containers, volumes, custom compute, or “ShipFix hosts your app”

---

## 1. Hard constraints (agents must obey)

1. **No custom hosting / containers / volumes / PaaS infra.**
2. **Do not remove** Vite static or standalone Next support.
3. **Do not expand** into Hono/Nest/Python/Docker as primary work in A–C (Nest detection may already exist; leave it alone).
4. **Untrusted repo code runs only via `@shipfix/sandbox`.** Never `exec` user repo commands in `apps/api` or ad-hoc in the worker outside sandbox activities.
5. **Secrets never** appear in `run_events`, plans, LLM prompts, or UI. Use `@shipfix/secrets` vault (`encBlob` / `encIv` / `encDek`).
6. **AI proposes; validator disposes.** Do not bypass `validatePlan()` / `gateDeploy()`.
7. **Only GREEN (`deployable`) plans auto-deploy.** Yellow/Red finalize as diagnosis unless HITL upgrades them (Phase B/C).
8. **Prefer small PRs / tasks in the order below.** Do not start Phase B until Phase A acceptance criteria pass in CI (or clearly document blockers).
9. **Update tests with every behavior change.** Prefer offline golden pipeline tests before live E2E.
10. **README may be outdated.** Trust code + this guide. Update README only when a task’s acceptance criteria say so.

---

## 2. Architecture map (where things live)

```
apps/
  web/          Next.js product UI
  api/          Fastify control plane (auth, runs, SSE, providers)
  worker/       Temporal worker (registers activities)
packages/
  contracts/    Zod schemas: RepoContext, DeploymentPlan, run events
  analyzer/     static RepoContext builder
  planner/      synthesizeDeterministicPlan + LLM generatePlan
  validator/    validatePlan + mvpSupport (honesty boundary)
  provisioner/  Neon Postgres
  adapters/     vercel, render
  verifier/     HTTP + CORS + (soon) db_connect
  workflow/     Temporal workflow + activities
  sandbox/      ONLY place untrusted code may exec
  secrets/      envelope encryption
  db/           Drizzle schema
```

### Deploy pipeline today (`packages/workflow/src/workflows.ts`)

```
analyzeRepo
  → proposePlan (deterministic or LLM → validatePlan)
  → gateDeploy          # only classification === "deployable"
  → provisionManagedServices
  → deployBackendServices
  → deployFrontendServices
  → verifyDeployedPlan
  → finalizeDeployRun
```

### Critical files you will touch

| Concern | Primary files |
|--------|----------------|
| Deterministic Next+API | `packages/planner/src/synthesize.ts` |
| MVP allowlist / copy | `packages/validator/src/mvpSupport.ts`, `packages/validator/src/validate.ts` |
| Neon URLs | `packages/provisioner/src/neon.ts`, `packages/provisioner/src/types.ts` |
| Env resolution | `packages/workflow/src/resolveEnv.ts` |
| Deploy activities | `packages/workflow/src/activities.ts` |
| Workflow order | `packages/workflow/src/workflows.ts` |
| Verification | `packages/verifier/src/verify.ts`, `verificationOutcome.ts` |
| Finalize honesty | `packages/workflow/src/finalizeDeployRun.ts` |
| Render env update | `packages/adapters/render/src/render.ts` (`setEnv`) |
| DB schema | `packages/db/src/schema.ts` |
| API routes | `apps/api/src/index.ts` |
| Snapshots / UI data | `apps/api/src/snapshot.ts`, `apps/web/app/lib/api.ts` |
| Outcome UX | `apps/web/app/components/OutcomeBanner.tsx`, `CurrentState.tsx`, `PlanPanel.tsx` |
| Golden tests | `packages/analyzer/test/goldenPipeline.test.ts` |

---

## 3. Current baseline (do not “rediscover”)

### Already works

- Vite + Express + Neon deterministic green path (`golden-fullstack`)
- Standalone Next `frontend_ssr` on Vercel (`golden-next`)
- Express **and** Fastify as `node_api` on Render (framework-agnostic start)
- `generated_from_service` / `generated_from_managed` env wiring at deploy
- Neon provision + sealed connection string
- HTTP `health_path`, `frontend_loads`, `cors_from` (CORS currently **optional**)
- Basic My Apps dashboard, run history, SSE timeline, redeploy-from-plan (same SHA)
- Render adapter already has `setEnv(externalId, env, credentials)`

### Known blockers for the primary path

1. **`synthesize.ts`:** `if (next && (frontend || backend)) return null` — Next + separate API goes to LLM.
2. **Migrations:** any `managed.migration !== "none"` → validator `migration_required` → Yellow → `gateDeploy` blocks.
3. **CORS origin env:** backend `CORS_ORIGIN`-like vars become `user_secret` because frontend URL is unknown at backend deploy time.
4. **`user_secret`:** `resolveEnv.ts` always returns `missing_secret`; `run_inputs` table exists; API TODO at `apps/api/src/index.ts`.
5. **`db_connect` in verifier:** stubbed skip (`verify.ts`).
6. **`cors_from` / `db_connect`:** in `OPTIONAL_VERIFICATION_CHECKS` — failures do not block `succeeded`.
7. **`externalId`:** loaded in API but **not** exposed on web `SnapshotResource` / UI.
8. **`verifySystem`:** throws `notImplemented`.

---

## 4. Work order (mandatory sequence)

```
A1 Deterministic Next+API synthesis + golden fixture
A2 Neon pooled vs direct + Prisma migrate activity
A3 CORS/origin completion (post-frontend Render setEnv)
A4 Verification honesty (db_connect required; cors_from required for split stacks; outcome UI)
A5 Docs/README truth + smoke notes for primary path
── Phase A done ──
B1 POST /runs/:id/inputs + question UI + resolveEnv reads inputs
B2 Project env/secrets (single production)
B3 Redeploy latest default-branch SHA
B4 Provider deep links (externalId → Open in …)
B5 App-home verification summary + light polling
── Phase B done ──
C1 Structured diagnosis objects (CORS web→api, etc.)
C2 Yellow HITL → revalidate → Green without full re-analyze
C3 Recovery/retry (implement verifySystem / bounded re-verify/redeploy)
C4 Drizzle migrate (mirror Prisma path)
C5 GitHub App / private repos / push deploys (start only after B3)
```

**Rule:** finish A1 before A2. Finish A2 before treating Prisma apps as Green. Prefer A3 before declaring split-stack “proven live.”

---

# Phase A — Addictive primary path

## A1 — Deterministic Next + API (+ Neon) synthesis + golden fixture

### Goal

A pnpm monorepo with Next App Router web + Express/Fastify API (+ optional Postgres) produces a **deterministic** `DeploymentPlan` that the validator can classify `deployable` (when no Prisma migration / unresolved secrets).

### Why first

Adapters already deploy `frontend_ssr` and `node_api`. The planner **refuses** the topology we sell. Fix planning before migrations/UI.

### Files to change

- `packages/planner/src/synthesize.ts` (**main**)
- `packages/validator/src/mvpSupport.ts` (update `MVP_SUPPORT_SUMMARY` text)
- `packages/analyzer/test/fixtures/golden-next-api/` (**new fixture**)
- `packages/analyzer/test/goldenPipeline.test.ts` (new describe block)
- Optionally planner unit tests if present

### Implementation steps

#### Step A1.1 — Relax slice matching

In `matchSupportedSlice()`:

**Today (broken for primary path):**

```ts
if (next && (frontend || backend)) return null;
```

**Required behavior:**

| Shape | Deterministic? |
|-------|----------------|
| Vite frontend only | yes (existing) |
| Backend only | yes (existing) |
| Next only | yes (existing) |
| Vite + backend (+ optional db) | yes (existing) |
| **Next + backend (+ optional db)** | **YES — add this** |
| Next + Vite frontend | no → `null` (LLM) |
| Two backends / two Next apps | no → `null` |

Replace the blanket reject with:

```ts
// Next + separate static frontend is ambiguous (which is the real UI?).
if (next && frontend) return null;
// Next + one Node backend is the primary supported topology.
// (next && backend) is ALLOWED.
```

Keep rejecting unknown languages/frameworks in the loop as today.

#### Step A1.2 — Synthesize Next as `web` when backend exists

Today the Next block always uses service id `"web"` and wires DB to `"web"`. That remains correct for Next+API:

- `api` = backend on Render
- `web` = Next on Vercel `frontend_ssr`
- `db` = Neon when postgres needed

**When `next` is present, do NOT also emit a Vite frontend.**

**Env wiring for Next when `backend` exists:**

For each env ref on the Next service:

1. `PORT` → `provider_injected` (rare on Vercel; harmless)
2. DB URL patterns → `generated_from_managed` / `db.connectionUrl` **only if Next itself talks to DB** (standalone Next case). For Next+API, prefer DB on API only unless Next code refs `DATABASE_URL`.
3. API URL patterns (`API_URL_RE`, including `NEXT_PUBLIC_*`) → `generated_from_service` / `api.publicUrl` + wiring edge `api.publicUrl → web.<ENV>`
4. Else → `askSecret` (Yellow)

Reuse the same `API_URL_RE` already in `synthesize.ts`. Confirm `NEXT_PUBLIC_API_URL` matches (it should via `\w*API\w*_URL`).

**Verification for Next+API:**

- `web` → `frontend_loads`
- `api` → `health_path` (if grounded)
- `api` → `cors_from` target `"web"` (same as Vite+API block)
- `db` → `db_connect` when managed db present (still stubbed until A4; keep emitting the check)

Mirror the Vite frontend hardcoded-localhost blocker for the Next service root when backend exists.

#### Step A1.3 — CORS env vars when frontend is Next

Today `FRONTEND_ORIGIN_RE` secrets are only asked when `frontend` (Vite) is set:

```ts
} else if (FRONTEND_ORIGIN_RE.test(name) && frontend) {
```

Change to treat **Next as a frontend origin source** for planning purposes:

```ts
} else if (FRONTEND_ORIGIN_RE.test(name) && (frontend || next)) {
  // Still askSecret for now OR mark for deferred wiring (A3).
  // In A1 it is OK to keep askSecret (Yellow) — A3 removes this for auto path.
```

**A1 acceptance allows Yellow if only CORS secret blocks.** Prefer documenting that A3 clears it. Do **not** invent a fake frontend URL in A1.

Better A1 approach (recommended): if `(frontend || next)` and `FRONTEND_ORIGIN_RE`, push env as:

```ts
{ name, source: "generated_from_service", ref: "web.origin" }
```

and add wiring `web.origin → api.<CORS_ENV>`, **but do not resolve it at backend deploy time**.

Then in A3, after frontend is live, call Render `setEnv` and optionally trigger redeploy. In A1, `resolveEnv` will fail `service_not_live` for `web` during backend deploy — that would skip API deploy today.

**So for A1, keep CORS as `user_secret` / askSecret** to avoid breaking backend deploy. Clear it in **A3** with deferred wiring. Document this explicitly in the A1 PR description.

#### Step A1.4 — Create fixture `golden-next-api`

Create under `packages/analyzer/test/fixtures/golden-next-api/`:

```
golden-next-api/
  package.json                 # private workspace root
  pnpm-workspace.yaml          # packages: apps/*
  apps/web/
    package.json               # next dependency, scripts build
    app/page.tsx               # simple page reading NEXT_PUBLIC_API_URL
    app/layout.tsx
  apps/api/
    package.json               # express (or fastify), pg, cors; scripts start
    src/index.js               # GET /health, CORS from CORS_ORIGIN or *
```

**Requirements:**

- `monorepoTool` must detect `pnpm_workspace`
- Web: `framework: "next"`, `role: "fullstack"`
- API: `framework: "express"` (or fastify), `role: "backend"`, grounded `/health`
- Env refs: `apps/web:NEXT_PUBLIC_API_URL`, `apps/api:DATABASE_URL`, `apps/api:PORT`
- Prefer **no Prisma** in A1 fixture (use `pg`) so plan can be Green without A2
- Prefer **no `CORS_ORIGIN` env ref** in A1 fixture (use `cors({ origin: true })` or `*`) so A1 can be Green without A3

Copy structure/style from `golden-fullstack` and `golden-next`.

#### Step A1.5 — Golden pipeline test

In `packages/analyzer/test/goldenPipeline.test.ts` add:

```ts
describe("golden Next+API monorepo: analyze -> synthesize -> validate", () => {
  it("detects apps/web next + apps/api express", ...);
  it("synthesizes deterministic frontend_ssr + node_api + neon", ...);
  it("stays deployable through validator with full caps", ...);
});
```

Assert exactly:

- `planSource === "deterministic"`
- services: `web.type === "frontend_ssr"`, `web.provider === "vercel"`, `web.rootDir === "apps/web"`
- services: `api.type === "node_api"`, `api.provider === "render"`, `api.rootDir === "apps/api"`
- wiring includes `api.publicUrl → web.NEXT_PUBLIC_API_URL`
- `deployOrder` includes `db` (if postgres), then `api`, then `web`
- existing `golden-fullstack` and `golden-next` describes still pass

#### Step A1.6 — Regression guard

Add a negative test (planner or golden):

- Repo with Next **and** Vite frontend → `synthesizeDeterministicPlan` returns `null`

### A1 acceptance criteria

- [ ] `pnpm --filter @shipfix/analyzer test` passes including new golden
- [ ] `pnpm --filter @shipfix/planner test` (if any) passes
- [ ] `pnpm --filter @shipfix/validator test` passes
- [ ] Vite+Express and standalone Next goldens still green
- [ ] `MVP_SUPPORT_SUMMARY` mentions Next SSR + Node API + Neon (not “static-only”)
- [ ] No Railway / migration execution / HITL in this PR

### A1 out of scope

Migrations, CORS auto-complete, Railway, UI redesign, GitHub App.

---

## A2 — Prisma migrate on Neon (direct vs pooled) + drop blanket Yellow

### Goal

When plan says `migration: "prisma"`:

1. Provision Neon
2. Run `prisma migrate deploy` against **direct** URL
3. Wire runtime services with **pooled** URL
4. Only then allow Green deploy (no `migration_required` Yellow for Prisma that ShipFix executes)

### Why

Popular apps use Prisma. Today Prisma ⇒ permanent Yellow ⇒ never addictive.

### Design

#### Neon connection roles

Extend Neon provision result to expose **two** URLs when available:

| Role | Use |
|------|-----|
| `pooled` | Runtime `DATABASE_URL` for API/Next |
| `direct` | `prisma migrate deploy` only |

**Implementation notes for `packages/provisioner/src/neon.ts`:**

1. After project create, inspect `connection_uris` (and/or Neon endpoints API if needed).
2. Prefer selecting URI by endpoint host patterns Neon documents (`-pooler` in host ⇒ pooled).
3. If only one URI is returned, store it as both but emit a run event warning: `neon_single_connection_uri`.
4. Change `ProvisionResult` / storage:

**Recommended storage approach (minimal schema churn):**

- Keep sealing **pooled** (or primary runtime) URL in `deployed_resources.enc_*` as today (`exposesEnv: DATABASE_URL`).
- Store **direct** URL sealed in `deployed_resources.meta` is **FORBIDDEN** (meta is jsonb, often logged).  
  **Better:** add optional columns or a second managed logical id.

**Preferred clean approach:**

- Add optional sealed fields OR a second resource row:
  - `serviceId: "db"` → pooled runtime URL (existing)
  - `serviceId: "db_direct"` → direct URL, `kind: "managed_db"`, not wired to app env by default
- Or extend vault payload JSON: seal a JSON object `{ pooled, direct }` in `encBlob` and teach `resolveEnv` / migrate activity to open fields.

**Recommended for agents (simplest correct):** seal JSON:

```json
{ "pooled": "postgres://...pooler...", "direct": "postgres://..." }
```

Update:

- `provisionManagedServices` sealing
- `resolveEnv` `generated_from_managed` → use `.pooled` (or top-level string for backward compat)
- migrate activity → use `.direct`

**Backward compatibility:** if opened secret is a plain postgres URL string, treat as both pooled and direct.

#### Migration activity

Add `runManagedMigrations(runId)` in `packages/workflow/src/activities.ts`.

**Workflow order change** in `workflows.ts`:

```
gateDeploy
→ provisionManagedServices
→ runManagedMigrations          # NEW
→ deployBackendServices
→ deployFrontendServices
→ verifyDeployedPlan
→ finalizeDeployRun
```

**Activity behavior:**

1. Load plan; find managed with `migration === "prisma"`.
2. If none, no-op success.
3. Open sandbox for the run’s repo/commit (same pattern as `analyzeRepo` — reuse sandbox provider used by analyze).
4. Determine Prisma schema location from analyzer evidence / `schema.prisma` path under API service `rootDir` (prefer service that consumes DB).
5. `exec` in sandbox with **direct** URL only in env:

```bash
# example — adjust to package manager + rootDir
pnpm exec prisma migrate deploy --schema <path>
# or: npx prisma migrate deploy
```

6. Timeout bounded (e.g. 3–5 minutes). Capture stdout/stderr **redacted**.
7. On non-zero exit: mark managed migration failed, emit `migration_failed` event with redacted detail, do **not** continue to deploy (or continue only if product decision is diagnose — **default: fail closed**, no backend deploy).
8. On success: emit `migration_completed`, persist marker in `deployed_resources.meta` like `{ migrationsApplied: true, tool: "prisma" }` (**non-secret**).

**Secret rule:** pass `DATABASE_URL` / `DIRECT_URL` into sandbox exec env for migrate **only**. Never log the value. Prefer setting `DIRECT_URL` if Prisma schema expects it; many schemas use:

```prisma
url      = env("DATABASE_URL")
directUrl = env("DIRECT_URL")
```

Support both:

- If schema text contains `directUrl`, pass pooled as `DATABASE_URL` and direct as `DIRECT_URL` during migrate?  
  **For migrate deploy, Prisma needs the direct URL on the URL used for migration.** Simplest honest approach:
  - Set `DATABASE_URL=<direct>` and `DIRECT_URL=<direct>` during migrate only.
  - Runtime deploy uses pooled for `DATABASE_URL`.

#### Validator change

In `packages/validator/src/validate.ts`, **remove or narrow** blanket:

```ts
if (m.migration && m.migration !== "none") {
  add({ code: "migration_required", severity: "needs_input", ... });
}
```

**New policy:**

- `migration === "prisma"` → **do not** Yellow solely for migration (ShipFix will run it). Optionally `warning` severity note.
- `migration === "drizzle"` → keep `needs_input` until C4.
- `migration` other → keep diagnose/needs_input.

Also stop setting `needsSetup = true` in synthesizer solely for prisma (`synthesize.ts` around migrationTool).

#### Analyzer improvement (small, recommended in A2)

In `packages/analyzer/src/data.ts`:

- If Prisma detected, check for `**/migrations/**` or `prisma/migrations` presence.
- If Prisma dep but **no** migrations folder, set `migrationTool: "none"` or emit evidence `prisma_without_migrations` so we don’t run empty migrate unnecessarily.

### Tests

- Unit: Neon URI selection pooled vs direct (mock API payloads)
- Unit: resolveEnv opens JSON `{pooled,direct}` and plain string compat
- Workflow/activity test with mock sandbox exec success/failure
- Validator: prisma plan can be `deployable` with caps connected
- Fixture: extend or add `golden-next-api-prisma` with minimal `schema.prisma` + empty migration optional

### A2 acceptance criteria

- [ ] Prisma plans are not forced Yellow only because of migrations
- [ ] Migrate runs after provision, before backend deploy
- [ ] Runtime API receives pooled URL; migrate used direct
- [ ] Failed migrate ⇒ no “succeeded” full-stack claim
- [ ] Secrets never in events
- [ ] Non-Prisma `pg`-only goldens still pass

### A2 out of scope

Drizzle execution (C4), HITL, Railway.

---

## A3 — CORS / origin completion (post-frontend env update)

### Goal

Split stacks that need `CORS_ORIGIN` / `FRONTEND_URL` style backend env become **auto-wireable** after the frontend is live, without requiring the user to paste the Vercel URL first.

### Preferred design (not HITL-first)

```
provision → migrate → deployBackend (without final CORS origin, or with temporary *)
→ deployFrontend
→ wireBackendOrigins (NEW)   # Render setEnv with web.origin + trigger redeploy/wait
→ verifyDeployedPlan
```

### Files

- `packages/planner/src/synthesize.ts` — classify CORS envs as deferred generated, not `user_secret`
- `packages/workflow/src/resolveEnv.ts` — allow skipping deferred env at backend first pass
- `packages/workflow/src/activities.ts` — new `wireDeferredServiceEnv` / `updateBackendOrigins`
- `packages/workflow/src/workflows.ts` — call after frontend deploy
- `packages/adapters/render/src/render.ts` — already has `setEnv`; may need “restart/redeploy” if PATCH env does not restart

### Implementation steps

#### Step A3.1 — Plan representation for deferred env

Options (pick one; recommended Option 1):

**Option 1 — literal marker + wiring edge**

- Env: `{ name: "CORS_ORIGIN", source: "generated_from_service", ref: "web.origin" }`
- At backend deploy, `resolveServiceEnv` gets `service_not_live` for `web`.
- Change backend deploy to support **partial env**: deploy with all resolvable env; treat unresolved `generated_from_service` refs to **frontend** ids as `deferred` instead of hard skip.
- Record deferred list on `deployed_resources.meta` for api: `{ deferredEnv: ["CORS_ORIGIN"] }`.

**Option 2 — new EnvVarSource `generated_from_service_deferred`**

- Requires contracts change + validator updates. Cleaner long-term.

Agents should prefer **Option 2** if touching contracts anyway; else Option 1 with explicit deferred handling.

#### Step A3.2 — Backend first deploy without CORS origin

If framework uses `cors` package with no origin env, A1 fixture may not need this. Real apps often need it.

Safe temporary policy when deferred:

- Omit `CORS_ORIGIN` on first Render deploy **or** set `CORS_ORIGIN=*` only if plan evidence shows permissive local cors — **do not invent `*` if repo requires explicit origin**.
- Honest path: deploy API, deploy web, set real origin, restart API, then verify CORS.

#### Step A3.3 — After frontend live

New activity:

1. Load plan wiring edges where `fromServiceId === "web"` and `fromField === "origin"|"publicUrl"` and `toServiceId === "api"`.
2. Resolve frontend URL from `deployed_resources`.
3. Call Render adapter `setEnv(apiExternalId, { CORS_ORIGIN: origin, ... }, creds)`.
4. Ensure service restarts (Render may require a deploy hook — check current adapter; add `redeploy`/`resume` if PATCH is insufficient).
5. Wait until API healthy again.
6. Emit `env_wired` / `cors_origin_updated` events (redacted values OK to show origin URL — origins are not secrets).

#### Step A3.4 — Validator / synthesizer

- Stop `askSecret` for `FRONTEND_ORIGIN_RE` when `(frontend || next)` exists.
- Remove related Yellow blockers for that case.

### A3 acceptance criteria

- [ ] Vite+API and Next+API plans with `CORS_ORIGIN` can be Green without user input
- [ ] CORS verification runs **after** origin wiring
- [ ] If wiring fails, outcome is `diagnosed`/`failed` with clear message — not silent success
- [ ] HITL remains available later (B1) for true user secrets (API keys, etc.)

### Fallback

If Render cannot update env reliably in this iteration, implement B1 HITL for CORS only and document as temporary — but **prefer** post-frontend `setEnv`.

---

## A4 — Verification honesty

### Goal

ShipFix only says full-stack live when:

1. frontend loads  
2. backend health passes  
3. CORS frontend→backend passes (**required** for split stacks)  
4. DB connect passes (**required** when plan includes db)  
5. migrations applied when Prisma was in plan (marker from A2)

### Files

- `packages/verifier/src/verify.ts` — implement `db_connect`
- `packages/verifier/src/verificationOutcome.ts` — remove `cors_from` and `db_connect` from optional set **for plans that include them** (simplest: remove both from `OPTIONAL_VERIFICATION_CHECKS`)
- `packages/workflow/src/finalizeDeployRun.ts` — ensure required failures block `succeeded`
- `packages/workflow/src/activities.ts` — pass sealed DB URL into verifier safely
- `apps/web/app/components/OutcomeBanner.tsx`, `CurrentState.tsx`, `apps/web/app/lib/resourceDisplay.ts`, `logTranslate.ts`
- Tests in `packages/verifier/test/*`, `packages/workflow/test/finalizeDeployRun.test.ts`

### Implement `db_connect`

Today stub:

```ts
if (check.check === "db_connect") {
  // skipped...
}
```

**Required:**

1. Verifier needs the connection string **without** putting it in run_events.
2. Activity `verifyDeployedPlan` should open vault for managed db resource and call something like:

```ts
verifyFromPlan(plan, resources, { dbConnections: { db: openedUrl } })
```

3. `db_connect` runs `SELECT 1` via `pg` (same as provisioner.verify).
4. On failure: `ok: false`, not skipped.
5. Never include connection string in outcome details (host only).

### Required vs optional policy

Update `OPTIONAL_VERIFICATION_CHECKS`:

- Remove `cors_from` and `db_connect` (both required when present in `plan.verification`).
- Keep optional empty or only truly advisory checks.

Update tests that currently assert they are optional.

### Outcome UI

When required verification fails:

- Do **not** show “Your app is live” / full-stack live.
- Show structured line items:
  - Backend health: pass/fail
  - Frontend loads: pass/fail
  - Frontend → backend (CORS): pass/fail
  - Database: pass/fail
- Point to timeline event for details.

Use existing verification entries in snapshot (`verificationFromEvents`) — improve `OutcomeBanner` / `CurrentState` to render a checklist from `snapshot.verification` filtered by plan checks.

### A4 acceptance criteria

- [ ] `db_connect` no longer stub-skipped
- [ ] Failed CORS or DB connect prevents `succeeded` full-stack
- [ ] UI surfaces which check failed
- [ ] Optional-check unit tests updated
- [ ] Secrets not logged

---

## A5 — Phase A documentation truth

### Goal

Align human docs with code after A1–A4.

### Files

- `README.md` — remove outdated “frontend_ssr not deployed”; describe primary topology
- `docs/e2e-manual-test.md` — add Next+API(+Prisma) checklist
- This guide — check off Phase A

### Acceptance

- [ ] README supported slice matches `mvpSupport.ts`
- [ ] Manual E2E steps exist for primary path

---

# Phase B — Daily utility

## B1 — `POST /runs/:id/inputs` + question UI + resolveEnv

### Goal

Users can answer `PlanQuestion`s (especially `kind: "secret"`). Values land in `run_inputs`. Deploy/resolve uses them. Workflow can wait in `awaiting_input` when needed.

### Existing assets

- Table `run_inputs` in `packages/db/src/schema.ts`
- Stage enum includes `awaiting_input`
- API TODO comment near end of `apps/api/src/index.ts`
- `PlanPanel` renders questions read-only

### API contract

```
POST /runs/:runId/inputs
Auth: required
Body: {
  answers: Array<{
    questionId: string,
    value: string
  }>
}
```

Behavior:

1. Authorize via `userCanAccessRun`.
2. Load latest plan; ensure each `questionId` exists.
3. For `kind: "secret"`: seal with vault into `enc_*`, `isSecret=true`, `valuePlain=null`.
4. For non-secrets: store `valuePlain`, enc null.
5. Upsert by `(runId, questionId)` (add unique index if missing).
6. If workflow is waiting on a Temporal signal, signal it (see below).
7. Return `{ ok: true, answered: string[] }`.

### resolveEnv change

In `packages/workflow/src/resolveEnv.ts`:

```ts
if (env.source === "user_secret") {
  // look up run_inputs for this run + matching question/env name
}
```

Pass `runInputs` map into `resolveServiceEnv` from deploy activities.

Matching rule:

- Prefer question id `secret-<serviceId>-<envName>` (synthesizer’s `askSecret` format)
- Fallback: any input whose question prompt/env maps to this name

### Workflow HITL (minimum for B1)

Two acceptable approaches:

**Approach A — pre-deploy only (simpler):**  
`gateDeploy` allows `needs_setup` **only if** all secret questions are already answered in `run_inputs` and a revalidation function upgrades classification to deployable (see C2). B1 can store answers; C2 flips Green.

**Approach B — Temporal signal (more complete):**  
If plan is Yellow due to secrets, set status `awaiting_input`, `condition`/`signal` wait in workflow, then continue.

**For B1:** implement API + UI + resolveEnv reading inputs.  
**For workflow pause:** implement Approach A first (answers before clicking Deploy), then Approach B if time.

### UI

- `PlanPanel.tsx`: inputs for each question; Submit answers button
- Call `POST /runs/:id/inputs`
- Never echo secret values back from GET endpoints

### B1 acceptance

- [ ] Secrets sealed at rest
- [ ] Deploy can resolve `user_secret` when answered
- [ ] GET run snapshot never returns secret values
- [ ] Questions UI works on `/runs/[runId]` and wizard

---

## B2 — Project env/secrets (single “production”)

### Goal

Returning users edit durable env vars for an app without re-answering plan questions every run.

### Schema (new)

Add table e.g. `project_secrets` / `project_env_vars`:

```
id, projectId, name, isSecret,
valuePlain nullable,
encBlob/encIv/encDek nullable,
createdAt, updatedAt
unique(projectId, name)
```

### API

```
GET    /apps/:projectId/env
PUT    /apps/:projectId/env        # upsert list
DELETE /apps/:projectId/env/:name
```

GET returns names + `isSecret` + non-secret values only.

### Resolution order at deploy

1. `provider_injected`
2. `generated_from_managed` / `generated_from_service`
3. `run_inputs` for this run
4. **project env**
5. else missing

### UI

Simple “Environment” section on `/apps/[projectId]`.

### B2 acceptance

- [ ] User can set `STRIPE_KEY` once; redeploy picks it up
- [ ] Secrets never listed in plaintext on GET

---

## B3 — Redeploy latest default-branch SHA

### Goal

“Redeploy” means **latest commit on project.defaultBranch**, not replay same SHA.

### Today

`POST /runs/:runId/deploy` copies plan and reuses source run `commitSha`.

### Change

Add:

```
POST /apps/:projectId/redeploy
```

Steps:

1. Resolve default branch SHA from GitHub (public API initially; GitHub App in C5).
2. Create new run `trigger: "retry"` or `"manual"`, new sha.
3. Start workflow mode `deploy` (re-analyze+plan **or** reuse last plan carefully).

**Honest default:** re-run analyze+plan+deploy on latest SHA (safer).  
Plan reuse only when commit unchanged.

### UI

Dashboard / app detail primary button: **Redeploy latest**.

Keep “Retry this plan” as secondary for same SHA debugging.

### B3 acceptance

- [ ] Redeploy latest fetches new SHA when branch moved
- [ ] Old “retry same plan” still available

---

## B4 — Provider deep links

### Goal

Show “Open in Vercel / Render / Neon” using `externalId`.

### Files

- `apps/api/src/snapshot.ts` — include `externalId` on `SnapshotResource`
- `apps/web/app/lib/api.ts` — mirror type
- `apps/web/app/lib/resourceDisplay.ts` / `CurrentState.tsx` / `AppCard.tsx` — links

### URL patterns (verify against current provider docs while implementing)

| Provider | Example |
|----------|---------|
| Vercel | `https://vercel.com/<team>/...` or project URL from API if stored |
| Render | `https://dashboard.render.com/web/<externalId>` |
| Neon | `https://console.neon.tech/app/projects/<externalId>` |

If team slug unknown, store console URL in `deployed_resources.meta.consoleUrl` at provision/deploy time (non-secret) — **best**.

### B4 acceptance

- [ ] Live resources show provider console link
- [ ] No secrets in links

---

## B5 — App-home verification summary + light polling

### Goal

`/apps/[projectId]` and `/` feel alive without manual refresh.

### Implementation

- Poll `GET /apps/:projectId` every 5–10s while latest run non-terminal
- Verification checklist card (reuse A4 UI pieces)
- Dashboard: show last verification state badges (CORS/DB/health)

### B5 acceptance

- [ ] In-progress deploy updates without full page reload
- [ ] Failed checks visible on app home

---

# Phase C — Differentiation depth

## C1 — Stronger structured diagnosis

### Goal

Replace vague strings with structured diagnosis objects the UI can render.

### Suggested event/data shape

```ts
{
  code: "cors_failed",
  fromServiceId: "web",
  toServiceId: "api",
  fromUrl: "https://app.vercel.app",
  toUrl: "https://api.onrender.com",
  evidence: { statusCode, allowOriginHeader },
  action: "Set CORS_ORIGIN to the frontend origin and redeploy the API."
}
```

Emit from verifier / finalize; translate in `logTranslate.ts`; render in OutcomeBanner.

Cover at least: `cors_failed`, `db_unreachable`, `health_failed`, `migration_failed`, `env_unresolved`.

---

## C2 — Yellow HITL → Green without blind re-analyze

### Goal

After secrets/env answered, re-validate plan in place and deploy.

### Flow

1. User answers inputs / project env (B1/B2)
2. `POST /runs/:id/continue` or auto on deploy click
3. Server loads plan + ctx (persist RepoContext on plan/run if needed)
4. `validatePlan(plan, ctx, caps)` again with “secrets satisfied” capability
5. If `deployable`, start deploy workflow from gate (or signal waiting workflow)

**Do not** require full LLM replan for answered secrets.

May need to persist `RepoContext` on the run (jsonb) if not already — check analyze events / DB. If only in events, either store `runs.repoContext` column or re-analyze (re-analyze OK if public repo; prefer persist).

---

## C3 — Recovery / retry (`verifySystem`)

### Goal

Replace stub:

```ts
export async function verifySystem(_runId: string): Promise<{ ok: boolean }> {
  throw new Error("notImplemented");
}
```

### Bounded recovery loop (keep small)

In workflow after verify failures:

1. Classify failure (CORS vs health vs db)
2. Allowed fixes only:
   - re-call `wireDeferredServiceEnv`
   - re-`verifyDeployedPlan`
   - once: redeploy single failed service via adapter
3. Max 1–2 attempts; then diagnose

Do **not** build open-ended autonomous coding agents mutating repos.

---

## C4 — Drizzle migrate

Mirror A2:

- Analyzer already can set `migrationTool: "drizzle"` (add fixture!)
- Run `drizzle-kit migrate` or package script detected from `package.json`
- Use direct URL
- Validator: stop Yellow for drizzle once executed
- Tests required (Drizzle is currently untested)

---

## C5 — GitHub App / private repos / push deploys

### Goal

- Private repo clone via installation token
- Webhook on push → create run `trigger: "push"` → deploy

### Prerequisites

B3 (redeploy latest) should exist so push deploys share SHA resolution logic.

### Files / work

- GitHub App credentials in `provider_accounts` or env
- `POST /webhooks/github` signature verify
- Sandbox clone with token (analyze already has token field in `CloneSpec`)
- Project setting: `autoDeployOnPush: boolean` (new column)

### Honesty

Push deploy still must pass gate + verification. No “deployed” without proof.

---

# 5. Testing strategy (all phases)

### Always run before claiming a task done

```bash
pnpm typecheck
pnpm --filter @shipfix/analyzer test
pnpm --filter @shipfix/planner test
pnpm --filter @shipfix/validator test
pnpm --filter @shipfix/verifier test
pnpm --filter @shipfix/workflow test
pnpm --filter @shipfix/provisioner test
pnpm --filter @shipfix/adapters-vercel test
pnpm --filter @shipfix/adapters-render test
```

(Adjust filter names to match each package’s `package.json` name.)

### Golden offline nets (mandatory for A1/A2)

- `golden-fullstack` (Vite+Express) must stay green
- `golden-next` (standalone) must stay green
- `golden-next-api` (new) must go green in A1
- Prisma variant green only after A2

### Manual E2E (after A4)

Follow `docs/e2e-manual-test.md` plus primary path:

1. Connect Neon/Render/Vercel
2. Deploy public Next+API(+Prisma) monorepo
3. Confirm live links + verification checklist all pass
4. Confirm provider console links (after B4)

---

# 6. Definition of done per phase

## Phase A done when

A stranger can paste a **public** pnpm monorepo (Next App Router + Express/Fastify + Neon/Prisma), connect providers, click Deploy, and get:

- deterministic plan (no LLM required for this shape)
- migrations applied
- services wired
- verification required checks passed
- UI does not claim live unless proven

Vite+Express and standalone Next still work.

## Phase B done when

Users return to an app page to:

- answer secrets / edit env
- redeploy latest commit
- open provider consoles
- see verification status update live

## Phase C done when

Failures explain **what broke between which services**, Yellow can become Green via answers, bounded recovery can unstick common verify failures, Drizzle works like Prisma, and GitHub push deploys exist for connected repos.

---

# 7. Anti-patterns (fail the PR if present)

1. Adding Railway marketing or adapter “for completeness” before A–C done
2. Claiming success when CORS/DB checks failed or were skipped
3. Running `prisma migrate` on the API/worker host outside `@shipfix/sandbox`
4. Putting connection strings in `run_events`, `meta` plaintext, or UI
5. Removing Vite/static support to “simplify”
6. Expanding to Nest/Hono/Python as part of A1
7. Building ShipFix-owned container hosting
8. Bypassing `validatePlan` / `gateDeploy`
9. Huge PR that mixes A1+B2+C5 — split by task IDs
10. Updating README instead of tests to “show” support

---

# 8. Suggested PR / commit slicing

| PR | Title |
|----|-------|
| A1 | feat(planner): deterministic Next+API monorepo plans + golden fixture |
| A2 | feat(workflow): Prisma migrate with Neon direct/pooled URLs |
| A3 | feat(workflow): wire CORS origins after frontend deploy |
| A4 | feat(verifier): require db_connect + cors_from; outcome UI |
| A5 | docs: align README/E2E with primary topology |
| B1 | feat(api/web): run inputs for plan questions |
| B2 | feat: project-level production env vars |
| B3 | feat: redeploy latest default-branch SHA |
| B4 | feat: provider console deep links |
| B5 | feat(web): app-home verification polling |
| C1 | feat: structured cross-service diagnosis |
| C2 | feat: revalidate Yellow plans after inputs |
| C3 | feat(workflow): bounded verify/deploy recovery |
| C4 | feat: Drizzle migrate support |
| C5 | feat: GitHub App private repos + push deploys |

---

# 9. Quick reference — commands & local loop

```bash
# install / typecheck
pnpm install
pnpm typecheck

# local stack (4 terminals)
temporal server start-dev
pnpm dev:api
pnpm dev:worker
pnpm dev:web

# offline proof for A1
pnpm --filter @shipfix/analyzer test
```

Env requirements for live deploy tests: see root `.env.example` / README (Clerk, `DATABASE_URL`, `SHIPFIX_MASTER_KEY`, provider keys, `NEON_ORG_ID`, LLM only needed for non-deterministic repos).

---

# 10. If you are stuck

1. Re-read §1 Hard constraints and §7 Anti-patterns.
2. Find the smallest failing golden test and fix that first.
3. Do not “temporarily” skip verification to demo success.
4. Prefer diagnosis events over fake Green.
5. Ask for a human decision only when choosing between Option 1/2 in A3 or Approach A/B in B1 — defaults are already recommended above.
