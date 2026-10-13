# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:20.20-alpine3.22@sha256:8f47899606d000b0704e992f927fe7335adcd0d6c98851600072fb6e14a13e60

FROM ${NODE_IMAGE} AS base
RUN apk add --no-cache python3 make g++ \
  && corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/llm-gemini/package.json ./packages/llm-gemini/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile

# Prod bundle depends only on the lockfile; cached across source-only rebuilds.
FROM deps AS bundle
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
  pnpm deploy --filter=appointment-bot --prod --legacy /prod

FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/llm-gemini/tsconfig.json ./packages/llm-gemini/
COPY src ./src
COPY packages/llm-gemini/src ./packages/llm-gemini/src
RUN pnpm build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=bundle --chown=node:node /prod/ ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/packages/llm-gemini/dist ./packages/llm-gemini/dist
# Workspace package resolves via node_modules symlink into the deploy virtual store.
USER root
RUN mkdir -p node_modules/@personal-assistant/llm-gemini/dist \
  && cp -a packages/llm-gemini/dist/. node_modules/@personal-assistant/llm-gemini/dist/ \
  && mkdir -p /app/data \
  && chown -R node:node /app/data packages/llm-gemini/dist node_modules/@personal-assistant/llm-gemini/dist
USER node
CMD ["node", "dist/index.js"]
