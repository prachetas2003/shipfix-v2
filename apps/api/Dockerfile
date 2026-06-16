FROM node:22-bookworm-slim

WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @shipfix/api build

ENV NODE_ENV=production
ENV API_PORT=4000

EXPOSE 4000

CMD ["pnpm", "--filter", "@shipfix/api", "start:prod"]
