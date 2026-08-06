# Clinic Appointment Bot (Phase 1)

Supervisor-framework pack for a Telegram clinic bot. Phase 1 boots FAQ + Booking agents with MemorySaver; MCP and Telegram come later.

## Setup

From the monorepo root:

```sh
pnpm install
cp apps/appointment-bot/.env.example apps/appointment-bot/.env
# set GOOGLE_API_KEY in .env
```

## Commands

```sh
pnpm --filter appointment-bot check   # typecheck
pnpm --filter appointment-bot smoke   # bootstrap + seed agents
pnpm --filter appointment-bot smoke -- --invoke  # also call Gemini
pnpm --filter appointment-bot dev     # print runtime status
```

## Layout

- `src/composition/` — pack bootstrap (`clinic-pack.ts`) and seed agents
- `src/prompts/` — supervisor / FAQ / booking prompts
- `src/llm/` — Gemini `ILLMConnector`
- `src/adapter/` — Telegram (Phase 4)
- `src/tools/` — EspoCRM MCP tools (Phase 2)
- `data/` — `runtime-agents.json`, `cron-jobs.json`
