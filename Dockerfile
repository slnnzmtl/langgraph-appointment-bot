FROM node:20-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/llm-gemini/package.json packages/llm-gemini/tsconfig.json ./packages/llm-gemini/
COPY src ./src
COPY packages/llm-gemini/src ./packages/llm-gemini/src

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:20-alpine
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/llm-gemini/package.json ./packages/llm-gemini/
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/llm-gemini/dist ./packages/llm-gemini/dist

CMD ["node", "dist/index.js"]
