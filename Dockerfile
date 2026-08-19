ARG NODE_IMAGE=node:20.20-alpine3.22@sha256:8f47899606d000b0704e992f927fe7335adcd0d6c98851600072fb6e14a13e60

FROM ${NODE_IMAGE} AS build
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/llm-gemini/package.json packages/llm-gemini/tsconfig.json ./packages/llm-gemini/
COPY src ./src
COPY packages/llm-gemini/src ./packages/llm-gemini/src

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM ${NODE_IMAGE}
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/llm-gemini/package.json ./packages/llm-gemini/
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/llm-gemini/dist ./packages/llm-gemini/dist

RUN chown -R node:node /app
USER node

CMD ["node", "dist/index.js"]
