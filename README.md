# Clinic Appointment Bot (Phase 3)

Supervisor-framework pack for a Telegram clinic bot. Phase 3 polishes supervisor/FAQ/booking prompts (route by agent id, identity-first booking) and adds scripted identity smoke. Telegram UI lands in Phase 4.

## Setup

```sh
pnpm install
cp .env.example .env
# set GOOGLE_API_KEY, ESPOCRM_URL, ESPOCRM_API_KEY, ESPOCRM_ASSIGNED_USER_ID
# optional: SMOKE_KNOWN_TELEGRAM_ID for --identity known path
```

## Commands

```sh
pnpm check   # typecheck
pnpm test    # identity + HITL unit tests
pnpm smoke   # bootstrap + live MCP stdio + prompt sync check
pnpm smoke -- --invoke    # FAQ routing via Gemini
pnpm smoke -- --identity  # known vs unknown telegram_id booking smoke
pnpm dev     # print runtime status
```

## Layout

- `src/composition/` — pack bootstrap, MCP adapters, capability providers
- `src/tools/` — EspoCRM MCP LangChain tools + telegram user context
- `src/prompts/` — supervisor / FAQ / booking prompts (copy into `data/runtime-agents.json` when changed)
- `src/llm/` — Gemini `ILLMConnector`
- `src/adapter/` — Telegram (Phase 4)
- `data/` — `runtime-agents.json`, `cron-jobs.json`
- `packages/langgraph-supervisor-expert-bootstrap` — supervisor framework workspace package
