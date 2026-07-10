# Phases A–C checklist

Use with [`implementation-guide-phases-abc.md`](./implementation-guide-phases-abc.md).
Check items only when that guide’s **acceptance criteria** pass (tests + behavior).

## Phase A — Addictive primary path

- [x] **A1** Deterministic Next + API (+ Neon) synthesis + `golden-next-api` fixture
- [x] **A2** Neon pooled/direct + Prisma migrate activity; Prisma no longer blanket Yellow
- [x] **A3** CORS/origin completion via post-frontend Render `setEnv` (prefer over HITL)
- [x] **A4** `db_connect` implemented; `cors_from` + `db_connect` required; outcome UI honest
- [x] **A5** README + E2E docs match code (primary topology truth)

**Phase A exit:** stranger can ship Next App Router + Express/Fastify + Neon(/Prisma) monorepo with proven live verification. Vite+Express and standalone Next still work.

## Phase B — Daily utility

- [x] **B1** `POST /runs/:id/inputs` + question UI + `resolveEnv` reads `run_inputs`
- [x] **B2** Project-level production env/secrets
- [x] **B3** Redeploy latest default-branch SHA (keep same-SHA retry secondary)
- [x] **B4** Expose `externalId` / console URLs → Open in Vercel/Render/Neon
- [x] **B5** App-home verification summary + light polling

**Phase B exit:** users return to manage env, redeploy latest, open providers, watch health.

## Phase C — Differentiation depth

- [ ] **C1** Structured diagnosis (`cors_failed` web→api, etc.)
- [ ] **C2** Yellow HITL → revalidate → Green without blind LLM replan
- [ ] **C3** Bounded recovery (`verifySystem` real; max 1–2 attempts)
- [ ] **C4** Drizzle migrate (mirror Prisma; add fixtures)
- [ ] **C5** GitHub App / private repos / push deploys

**Phase C exit:** failures are precise, Yellow can become Green via answers, common verify failures can unstick, Drizzle works, push deploys exist.

## Phase D (later — do not start yet)

Railway-as-target expansion, Hono/Nest primary support, workers/queues, multi-env staging, teams/orgs, custom compute — **out of scope** until A–C exit criteria met.

## Agent rules (summary)

1. Implement in order A1→A5 then B then C.
2. One PR per task ID when possible.
3. No PaaS/compute; no removing Vite/standalone Next.
4. Secrets only in vault columns; never in events/UI.
5. Do not claim live if required verification failed or skipped.
