# Deploy ShipFix on Render + Vercel

This is the recommended controlled-alpha deployment layout:

- `apps/web` on Vercel
- `apps/api` as a Render Web Service
- `apps/worker` as a Render Background Worker
- A hosted Postgres database for ShipFix control-plane state
- A reachable Temporal server or Temporal Cloud endpoint

## 1. Required infrastructure

Create these before deploying:

- A Postgres database for ShipFix itself. This is separate from databases ShipFix provisions for user apps.
- A Temporal endpoint reachable by both Render services.
- A Clerk app for product authentication.

Apply the DB schema from your machine or CI:

```bash
pnpm install
pnpm --filter @shipfix/db db:push
```

For a production database, prefer checked-in migrations once the schema stabilizes.

## 2. Render

Create services from `render.yaml` or create them manually.

### API service

Type: Web Service

Build command:

```bash
corepack enable && corepack prepare pnpm@9.15.4 --activate && pnpm install --frozen-lockfile && pnpm --filter @shipfix/api build
```

Start command:

```bash
pnpm --filter @shipfix/api start
```

Health check path:

```text
/health
```

Environment:

```env
NODE_ENV=production
DATABASE_URL=
AUTH_MODE=clerk
CLERK_SECRET_KEY=
SHIPFIX_MASTER_KEY=
SHIPFIX_ADMIN_TOKEN=
TEMPORAL_ADDRESS=
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=shipfix
WEB_ORIGIN=https://YOUR_WEB_DOMAIN
```

Render provides `PORT`; ShipFix reads it automatically when `API_PORT` is not set.

### Worker service

Type: Background Worker

Build command:

```bash
corepack enable && corepack prepare pnpm@9.15.4 --activate && pnpm install --frozen-lockfile && pnpm --filter @shipfix/worker build
```

Start command:

```bash
pnpm --filter @shipfix/worker start
```

Environment:

```env
NODE_ENV=development
DATABASE_URL=
SHIPFIX_MASTER_KEY=
TEMPORAL_ADDRESS=
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=shipfix
LLM_PROVIDER=
LLM_MODEL=
OPENAI_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
NEON_ORG_ID=
```

Alpha limitation: the current repo-analysis sandbox is still the local/dev sandbox. The worker uses `NODE_ENV=development` until the production E2B sandbox provider is implemented.

## 3. Vercel

Create a Vercel project for `apps/web`.

Project settings:

- Root Directory: `apps/web`
- Framework Preset: Next.js
- Install Command: from `apps/web/vercel.json`
- Build Command: from `apps/web/vercel.json`

Environment:

```env
NEXT_PUBLIC_API_URL=https://YOUR_RENDER_API_DOMAIN
NEXT_PUBLIC_AUTH_MODE=clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
```

Do not set backend secrets in Vercel. Never expose `DATABASE_URL`, LLM keys, `CLERK_SECRET_KEY`, `SHIPFIX_MASTER_KEY`, provider API keys, or `SHIPFIX_ADMIN_TOKEN` through `NEXT_PUBLIC_*`.

## 4. Clerk

In Clerk:

- Add the Vercel web URL to allowed origins.
- Use `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in Vercel.
- Use `CLERK_SECRET_KEY` in Render API only.

## 5. Smoke test

After deploy:

1. Open the Vercel URL.
2. Sign in.
3. Open the Render API health URL:

   ```text
   https://YOUR_RENDER_API_DOMAIN/health
   ```

4. In ShipFix, start a deployment for the known supported demo repo.
5. Confirm the timeline reaches database, backend, frontend, and verification.
6. Confirm My Apps shows the frontend app link, backend API health, and database metadata.
