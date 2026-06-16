# ShipFix Production Deployment

This is the alpha production topology:

- `apps/web` on Vercel.
- `apps/api` as a long-running Node service on a VM.
- `apps/worker` as a long-running Node service on the same VM.
- Temporal on the same VM through Docker Compose.
- Neon as the ShipFix control-plane Postgres database.

The web app only receives public browser config. All LLM, provider, database,
Clerk secret, admin, and vault secrets stay on the VM in `.env.production`.

## 1. Prepare The VM

Install Docker, Docker Compose, git, Node 20+ if you want to run local pnpm
commands on the VM, and clone ShipFix:

```bash
git clone https://github.com/YOUR_ORG/shipfix-v2.git
cd shipfix-v2
```

Create the production env file:

```bash
cp docs/production-env.example .env.production
nano .env.production
```

Generate the vault key:

```bash
openssl rand -base64 32
```

Paste that value into `SHIPFIX_MASTER_KEY`.

## 2. Required VM Environment

`.env.production` must contain:

```bash
NODE_ENV=production
DATABASE_URL=postgresql://...neon.../neondb?sslmode=require
API_PORT=4000
WEB_ORIGIN=https://YOUR-VERCEL-APP.vercel.app

TEMPORAL_ADDRESS=temporal:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=shipfix-prod

AUTH_MODE=clerk
CLERK_SECRET_KEY=sk_...
SHIPFIX_ADMIN_TOKEN=...
SHIPFIX_MASTER_KEY=...

LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
OPENAI_API_KEY=...

NEON_API_KEY=...
NEON_ORG_ID=...
RENDER_API_KEY=...
VERCEL_TOKEN=...
```

If you use Gemini or Anthropic, set `LLM_PROVIDER=gemini` with
`GEMINI_API_KEY`, or `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`.

Production startup fails fast if any required variable is missing, if
`AUTH_MODE` is not `clerk`, or if `TEMPORAL_TASK_QUEUE` is not exactly
`shipfix-prod`.

## 3. Apply The Database Schema

From a machine that has access to the Neon `DATABASE_URL`:

```bash
pnpm install
cp docs/production-env.example .env.production
# Fill .env.production first, then export DATABASE_URL for the db command:
export DATABASE_URL="$(grep '^DATABASE_URL=' .env.production | cut -d= -f2-)"
pnpm --filter @shipfix/db db:migrate
```

For a first scrappy deploy, `db:push` can be used instead of migrations, but
prefer checked-in migrations for repeatable production changes:

```bash
pnpm --filter @shipfix/db db:push
```

## 4. Start Temporal, API, And Worker

Build and start the production services:

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

Check containers:

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f shipfix-api shipfix-worker
```

The worker should log that it is polling:

```text
shipfix-prod
```

## 5. Check API Health

If the VM exposes port `4000` directly:

```bash
curl http://YOUR_VM_HOST:4000/health
```

Expected:

```json
{"ok":true}
```

Check protected admin diagnostics:

```bash
curl -H "X-ShipFix-Admin-Token: $SHIPFIX_ADMIN_TOKEN" \
  http://YOUR_VM_HOST:4000/admin/config-check
```

Confirm:

- `temporalReachable` is `true`.
- `temporalTaskQueue` is `shipfix-prod`.
- `workerRecentlySeen` is `true`.
- No secrets are present in the response.

## 6. Deploy The Web App To Vercel

In Vercel, set the project root directory to:

```text
apps/web
```

Build settings:

```text
Install Command: pnpm install --frozen-lockfile
Build Command: pnpm build
Output: .next
```

Set only these Vercel environment variables:

```bash
NEXT_PUBLIC_API_URL=https://YOUR_API_DOMAIN_OR_VM_HOST
NEXT_PUBLIC_AUTH_MODE=clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
```

Do not put these in Vercel web env:

```text
DATABASE_URL
CLERK_SECRET_KEY
SHIPFIX_MASTER_KEY
SHIPFIX_ADMIN_TOKEN
OPENAI_API_KEY
GEMINI_API_KEY
ANTHROPIC_API_KEY
NEON_API_KEY
RENDER_API_KEY
VERCEL_TOKEN
```

Deploy with the Vercel dashboard or CLI:

```bash
pnpm dlx vercel --prod
```

After Vercel gives you the production URL, update `WEB_ORIGIN` in
`.env.production` on the VM and restart API/worker:

```bash
docker compose -f docker-compose.prod.yml up -d --force-recreate shipfix-api shipfix-worker
```

## 7. Production Smoke Test

1. Open the Vercel web URL.
2. Sign in with Clerk.
3. Start a plan run for a known supported repo.
4. Confirm the run moves past `Repository analyzed` into `Generating deployment plan`.
5. Confirm `/admin/config-check` still shows `workerRecentlySeen: true`.

For deploy testing, connect provider credentials in ShipFix and run one known
Vite/Node/Postgres app through Vercel, Render, and Neon.
